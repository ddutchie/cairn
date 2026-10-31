/**
 * OS sandbox for agent shell commands: writes are confined to the working
 * directory (plus temp dirs and caches); reads and the network stay open so
 * builds, git and package managers keep working. macOS uses seatbelt
 * (`sandbox-exec`), Linux uses bubblewrap. Windows has no equivalent, so
 * commands run unconfined there and `sandboxStatus()` says so.
 *
 * Where a backend exists but does not work (bwrap blocked by user namespaces, sandbox-exec refusing
 * to nest) the sandbox is "unavailable", not off: `sandboxUnavailable()` reports it so callers fail
 * closed (ask the human) instead of silently running unconfined.
 *
 * The model can ask to leave the sandbox (`unsandboxed` on bash); that call is
 * always put to the human, one command at a time (see `RiskInfo.escalation`).
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type SandboxMode = "workspace-write" | "off";

export interface SandboxOptions {
  mode: SandboxMode;
  /** Extra directories commands may write to (the working directory is always included). */
  writableRoots?: string[];
  /** Block outbound network. Default false. */
  blockNetwork?: boolean;
  /** Directory whose tree is writable (the session cwd). Defaults to the command's cwd; a per-call workdir must not widen it. */
  root?: string;
  /** Command is an interactive shell on a PTY: keep its controlling terminal (no new session). */
  pty?: boolean;
}

export interface SandboxStatus {
  mode: SandboxMode;
  /** Whether commands are actually confined right now. */
  active: boolean;
  /** Whether this platform has a sandbox backend at all (false on Windows). */
  supported: boolean;
  backend: "seatbelt" | "bubblewrap" | "none";
  /** Why it is inactive, when it is. */
  reason?: string;
}

export interface Spawnable { file: string; args: string[] }

const SEATBELT = "/usr/bin/sandbox-exec";
let bwrapPath: string | null | undefined;
let seatbeltWorks: boolean | undefined;

/** `sandbox-exec` exists on every Mac but refuses to run inside another sandbox, so prove it works once. */
function findSeatbelt(): boolean {
  if (seatbeltWorks !== undefined) return seatbeltWorks;
  seatbeltWorks = fs.existsSync(SEATBELT)
    && spawnSync(SEATBELT, ["-p", "(version 1)(allow default)(deny file-write*)", "/usr/bin/true"], { stdio: "ignore", timeout: 5000 }).status === 0;
  return seatbeltWorks;
}

function findBwrap(): string | null {
  if (bwrapPath !== undefined) return bwrapPath;
  const r = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
  // --version works even where user namespaces are blocked; a real (no-op) run proves it can sandbox.
  bwrapPath = r.status === 0 && spawnSync("bwrap", ["--ro-bind", "/", "/", "true"], { stdio: "ignore" }).status === 0 ? "bwrap" : null;
  return bwrapPath;
}

function backendFor(platform: NodeJS.Platform): SandboxStatus["backend"] {
  if (platform === "darwin") return findSeatbelt() ? "seatbelt" : "none";
  if (platform === "linux") return findBwrap() ? "bubblewrap" : "none";
  return "none";
}

export function sandboxStatus(mode: SandboxMode, platform: NodeJS.Platform = process.platform): SandboxStatus {
  const supported = platform === "darwin" || platform === "linux";
  if (mode === "off") return { mode, active: false, supported, backend: "none", reason: "Turned off in settings" };
  const backend = backendFor(platform);
  if (backend !== "none") return { mode, active: true, supported, backend };
  const reason = platform === "win32" ? "Windows has no supported sandbox" : platform === "linux" ? "bubblewrap (bwrap) is missing or cannot create namespaces here; install it or allow unprivileged user namespaces" : "sandbox-exec is unavailable or refused to start (possibly because this app is itself sandboxed)";
  return { mode, active: false, supported, backend, reason };
}

/**
 * Why commands cannot be confined although the sandbox is on and this platform supports it; undefined
 * when they can be, when it is off, or when the platform has no sandbox (Windows runs unconfined).
 */
export function sandboxUnavailable(mode: SandboxMode, platform: NodeJS.Platform = process.platform): string | undefined {
  const st = sandboxStatus(mode, platform);
  return mode !== "off" && st.supported && !st.active ? st.reason : undefined;
}

/** What the model is told about its shell confinement ("" when there is nothing to say). */
export function sandboxPolicyNote(mode: SandboxMode, platform: NodeJS.Platform = process.platform): string {
  const st = sandboxStatus(mode, platform);
  if (st.active) {
    return "Shell commands run in a sandbox: they can read anywhere and use the network, but can only write inside the code directory and temp/cache directories. \"Operation not permitted\" or \"Read-only file system\" on a write elsewhere is the sandbox, not a bug. If a command really must write elsewhere, retry it with `unsandboxed: true` and a `reason`; the user is asked every time.";
  }
  const why = sandboxUnavailable(mode, platform);
  if (why) return `The shell sandbox is enabled but cannot start (${why}). Every shell command therefore needs the user's approval to run unsandboxed; keep them few and tell the user what you are doing.`;
  return "";
}

/** Resolve symlinks (/tmp → /private/tmp on macOS): seatbelt matches real paths. */
function real(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

const gitDirCache = new Map<string, string[]>();

/** A linked worktree or submodule keeps its index/refs/objects outside the cwd. */
function gitDirs(cwd: string): string[] {
  const hit = gitDirCache.get(cwd);
  if (hit) return hit;
  let dirs: string[] = [];
  try {
    const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd, encoding: "utf8", timeout: 3000 });
    if (r.status === 0) dirs = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch { /* no git */ }
  gitDirCache.set(cwd, dirs);
  return dirs;
}

function darwinCacheDir(): string[] {
  if (process.platform !== "darwin") return [];
  try {
    const r = spawnSync("getconf", ["DARWIN_USER_CACHE_DIR"], { encoding: "utf8", timeout: 2000 });
    return r.status === 0 && r.stdout.trim() ? [r.stdout.trim()] : [];
  } catch { return []; }
}

const HOME_CACHES = [".npm", ".cache", ".cargo", ".pnpm-store", ".yarn", ".bun", ".gradle", ".m2", ".node-gyp", "go", ".local/share/pnpm", "Library/pnpm", "Library/Caches"];

export function writableRoots(cwd: string, extra: string[] = [], home = os.homedir(), tmp = os.tmpdir()): string[] {
  const roots = [cwd, tmp, "/tmp", "/var/tmp", ...darwinCacheDir(), ...gitDirs(cwd), ...extra, ...HOME_CACHES.map((d) => path.join(home, d))];
  return [...new Set(roots.map(real))];
}

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Seatbelt policy: everything allowed except writes outside `roots` (and the network when blocked). */
export function seatbeltProfile(roots: string[], blockNetwork = false, readOnly: string[] = []): string {
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${roots.map((r) => `(subpath ${q(r)})`).join(" ")}`,
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/(tty|ttys[0-9]+|pty[a-z0-9]+|fd/[0-9]+)$"))',
  ];
  // Carve-outs inside writable roots (last match wins): places where a write becomes code that later runs unconfined.
  if (readOnly.length) lines.push(`(deny file-write* ${readOnly.map((r) => `(subpath ${q(r)})`).join(" ")})`);
  if (blockNetwork) lines.push("(deny network*)", '(allow network* (remote unix-socket))');
  return lines.join("\n");
}

export function bwrapArgs(roots: string[], blockNetwork = false, pty = false, readOnly: string[] = []): string[] {
  const args = ["--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev", "--unshare-pid", "--proc", "/proc"];
  for (const r of roots) if (fs.existsSync(r)) args.push("--bind", r, r);
  for (const r of readOnly) if (fs.existsSync(r)) args.push("--ro-bind", r, r);
  args.push("--die-with-parent");
  if (!pty) args.push("--new-session");
  if (blockNetwork) args.push("--unshare-net");
  return args;
}

/** Inside the writable roots, these stay read-only: git hooks and tool shims that later run outside the sandbox. */
export function readOnlyCarveOuts(roots: string[], cwd: string, home = os.homedir()): string[] {
  const out = [path.join(home, ".cargo", "bin")];
  for (const r of roots) out.push(path.join(r, ".git", "hooks"));
  for (const d of gitDirs(cwd)) out.push(path.join(d, "hooks"));
  return [...new Set(out.map(real))].filter((p) => roots.some((r) => p === r || p.startsWith(r + path.sep)));
}

/** Wrap a command so it runs confined; returns it unchanged when the sandbox is off or unavailable. */
export function wrapSandboxed(cmd: Spawnable, cwd: string, opts: SandboxOptions, platform: NodeJS.Platform = process.platform): Spawnable {
  if (opts.mode === "off") return cmd;
  const backend = backendFor(platform);
  if (backend === "none") return cmd;
  const roots = writableRoots(opts.root ?? cwd, opts.writableRoots);
  const ro = readOnlyCarveOuts(roots, opts.root ?? cwd);
  if (backend === "seatbelt") return { file: SEATBELT, args: ["-p", seatbeltProfile(roots, opts.blockNetwork, ro), cmd.file, ...cmd.args] };
  return { file: "bwrap", args: [...bwrapArgs(roots, opts.blockNetwork, opts.pty, ro), "--chdir", cwd, cmd.file, ...cmd.args] };
}

/** Hint appended to a failed command that looks like a sandbox write denial. */
export function sandboxDenialHint(output: string): string | undefined {
  if (!/Operation not permitted|Read-only file system|Permission denied/i.test(output)) return undefined;
  return "[this may be the sandbox: writes are limited to the working directory and temp dirs. If the command really needs to write elsewhere, retry with unsandboxed=true (the user will be asked).]";
}
