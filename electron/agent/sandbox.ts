/**
 * OS sandbox for agent shell commands: writes are confined to the working
 * directory (plus temp dirs and caches); reads and the network stay open so
 * builds, git and package managers keep working. macOS uses seatbelt
 * (`sandbox-exec`), Linux uses bubblewrap. Windows has no equivalent, so
 * commands run unconfined there and `sandboxStatus()` says so.
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
}

export interface SandboxStatus {
  mode: SandboxMode;
  /** Whether commands are actually confined right now. */
  active: boolean;
  backend: "seatbelt" | "bubblewrap" | "none";
  /** Why it is inactive, when it is. */
  reason?: string;
}

export interface Spawnable { file: string; args: string[] }

const SEATBELT = "/usr/bin/sandbox-exec";
let bwrapPath: string | null | undefined;

function findBwrap(): string | null {
  if (bwrapPath !== undefined) return bwrapPath;
  const r = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
  bwrapPath = r.status === 0 ? "bwrap" : null;
  return bwrapPath;
}

function backendFor(platform: NodeJS.Platform): SandboxStatus["backend"] {
  if (platform === "darwin") return fs.existsSync(SEATBELT) ? "seatbelt" : "none";
  if (platform === "linux") return findBwrap() ? "bubblewrap" : "none";
  return "none";
}

export function sandboxStatus(mode: SandboxMode, platform: NodeJS.Platform = process.platform): SandboxStatus {
  if (mode === "off") return { mode, active: false, backend: "none", reason: "Turned off in settings" };
  const backend = backendFor(platform);
  if (backend !== "none") return { mode, active: true, backend };
  const reason = platform === "win32" ? "Windows has no supported sandbox" : platform === "linux" ? "Install bubblewrap (bwrap) to enable the sandbox" : "sandbox-exec is unavailable";
  return { mode, active: false, backend, reason };
}

/** Resolve symlinks (/tmp → /private/tmp on macOS): seatbelt matches real paths. */
function real(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

export function writableRoots(cwd: string, extra: string[] = [], home = os.homedir(), tmp = os.tmpdir()): string[] {
  const roots = [cwd, tmp, "/tmp", "/var/tmp", ...extra, path.join(home, ".npm"), path.join(home, ".cache"), path.join(home, ".cargo"), path.join(home, ".pnpm-store"), path.join(home, "Library", "Caches")];
  return [...new Set(roots.map(real))];
}

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Seatbelt policy: everything allowed except writes outside `roots` (and the network when blocked). */
export function seatbeltProfile(roots: string[], blockNetwork = false): string {
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${roots.map((r) => `(subpath ${q(r)})`).join(" ")}`,
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/(tty|ttys[0-9]+|pty[a-z0-9]+|fd/[0-9]+)$"))',
  ];
  if (blockNetwork) lines.push("(deny network*)", '(allow network* (remote unix-socket))');
  return lines.join("\n");
}

export function bwrapArgs(roots: string[], blockNetwork = false): string[] {
  const args = ["--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev", "--proc", "/proc"];
  for (const r of roots) if (fs.existsSync(r)) args.push("--bind", r, r);
  args.push("--die-with-parent", "--new-session");
  if (blockNetwork) args.push("--unshare-net");
  return args;
}

/** Wrap a command so it runs confined; returns it unchanged when the sandbox is off or unavailable. */
export function wrapSandboxed(cmd: Spawnable, cwd: string, opts: SandboxOptions, platform: NodeJS.Platform = process.platform): Spawnable {
  if (opts.mode === "off") return cmd;
  const backend = backendFor(platform);
  if (backend === "none") return cmd;
  const roots = writableRoots(cwd, opts.writableRoots);
  if (backend === "seatbelt") return { file: SEATBELT, args: ["-p", seatbeltProfile(roots, opts.blockNetwork), cmd.file, ...cmd.args] };
  return { file: "bwrap", args: [...bwrapArgs(roots, opts.blockNetwork), "--chdir", cwd, cmd.file, ...cmd.args] };
}

/** Hint appended to a failed command that looks like a sandbox write denial. */
export function sandboxDenialHint(output: string): string | undefined {
  if (!/Operation not permitted|Read-only file system|Permission denied/i.test(output)) return undefined;
  return "[this may be the sandbox: writes are limited to the working directory and temp dirs. If the command really needs to write elsewhere, retry with unsandboxed=true (the user will be asked).]";
}
