/**
 * Child-process helpers: one home for spawning with a timeout, abort support
 * and bounded output (F6), plus the live helpers moved out of the retired
 * harness `lib/coding-tools/bash.ts` (F12).
 *
 * - `runProcess()` — one-shot spawn returning `{ code, signal, stdout, stderr,
 *   timedOut, aborted, truncated }`. Used by the bash tool, hook commands,
 *   ripgrep searches and automation scripts.
 * - `spawnTracked()` — long-lived spawn for jobs; the pid is tracked until the
 *   child settles so app shutdown can kill stragglers.
 * - `killTree()` — kill a process and all its children cross-platform.
 * - `platformShell()` — the interactive shell for a command string
 *   (powershell.exe on Windows, `$SHELL`/bash elsewhere).
 * - `getBashExecutable()` — Git Bash detection on Windows (never WSL bash).
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Shared byte budget for streamed tool output (see F14). */
export const DEFAULT_MAX_BYTES = 50_000;

// ── Bash executable + PID tracking (moved from coding-tools/bash.ts) ─────────

export function getBashExecutable(): string {
  if (process.platform !== "win32") {
    return "bash";
  }

  // 1. Check standard installation paths
  const standardPaths = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  if (process.env.USERPROFILE) {
    standardPaths.push(
      path.join(process.env.USERPROFILE, "AppData\\Local\\Programs\\Git\\bin\\bash.exe"),
      path.join(process.env.USERPROFILE, "AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe")
    );
  }
  if (process.env.LOCALAPPDATA) {
    standardPaths.push(
      path.join(process.env.LOCALAPPDATA, "Programs\\Git\\bin\\bash.exe"),
      path.join(process.env.LOCALAPPDATA, "Programs\\Git\\usr\\bin\\bash.exe")
    );
  }

  for (const p of standardPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // 2. Try to locate git.exe via PATH and find bash.exe nearby
  try {
    const gitPath = execSync("where git", { encoding: "utf8", windowsHide: true }).split("\r\n")[0]?.trim();
    if (gitPath && fs.existsSync(gitPath)) {
      const gitDir = path.dirname(gitPath);
      const candidateBin = path.resolve(gitDir, "..", "bin", "bash.exe");
      if (fs.existsSync(candidateBin)) {
        return candidateBin;
      }
      const candidateUsrBin = path.resolve(gitDir, "..", "usr", "bin", "bash.exe");
      if (fs.existsSync(candidateUsrBin)) {
        return candidateUsrBin;
      }
    }
  } catch {
    // Ignore error if 'where' fails
  }

  // 3. Search PATH for bash.exe (excluding WSL / System32)
  const pathDirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of pathDirs) {
    const lowerDir = dir.toLowerCase();
    if (lowerDir.includes("system32") || lowerDir.includes("syswow64") || lowerDir.includes("windows")) {
      continue;
    }
    const fullPath = path.join(dir, "bash.exe");
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }

  // Fallback to default "bash"
  return "bash";
}

const trackedPids = new Set<number>();

export function trackPid(pid: number): void { trackedPids.add(pid); }
export function untrackPid(pid: number): void { trackedPids.delete(pid); }

/** Kill a process and all its children cross-platform. */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true });
    } catch { /* ignore */ }
  } else {
    // Negative PID kills the entire process group
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Fallback: kill just the direct child if process-group kill fails
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }
  }
}

/** Called during Electron app shutdown to clean up any lingering children. */
export function killTrackedBashProcesses(): void {
  for (const pid of trackedPids) killTree(pid);
  trackedPids.clear();
}

/** The shell a command string runs in (powershell.exe on Windows). */
export function platformShell(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
  return { file: process.env.SHELL && /\/(ba|z)?sh$/.test(process.env.SHELL) ? process.env.SHELL : "/bin/bash", args: ["-c", command] };
}

// ── One-shot spawn ────────────────────────────────────────────────────────────

export interface RunProcessOptions {
  file: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, then stdin is ended (hook commands send their event this way). */
  stdin?: string | Buffer;
  /** Kill the child when this elapses; reported as `timedOut`. */
  timeoutMs?: number;
  /** Kill the child when this fires; reported as `aborted`. */
  signal?: AbortSignal;
  /** Per-stream char cap (stdout, or stdout+stderr when `combine`). Default unbounded. */
  maxChars?: number;
  /** `tail` drops the head (shell output); `head` drops the tail (searches). Default `tail`. */
  keep?: "head" | "tail";
  /** Char cap for stderr when streams stay separate. Defaults to `maxChars`. */
  maxStderrChars?: number;
  /** Kill the whole process group (POSIX) / tree (Windows taskkill) instead of just the child. Default true. */
  killTree?: boolean;
  /** Signal for the direct-kill path (ripgrep uses SIGTERM, like Node's own spawn-signal kill). Default `SIGKILL`. */
  killSignal?: NodeJS.Signals;
  /** Merge stderr into stdout chronologically (shell tools show one combined stream). */
  combine?: boolean;
  /** Kill the child as soon as the head cap is hit (searches stop scanning a huge tree). Default false. */
  killOnCap?: boolean;
}

export interface RunProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  /** Empty when `combine` is set (stderr is merged into stdout). */
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** True when output exceeded a cap and was dropped (per `keep`). */
  truncated: boolean;
  /** Set when the child could not be started at all. */
  error?: string;
}

/**
 * Spawn once and collect bounded output. Never rejects: spawn failure is
 * reported as `{ error }`, timeout as `{ timedOut }`, abort as `{ aborted }`.
 */
export function runProcess(opts: RunProcessOptions): Promise<RunProcessResult> {
  const {
    file,
    args = [],
    cwd,
    env = process.env,
    stdin,
    timeoutMs,
    signal,
    maxChars = Number.POSITIVE_INFINITY,
    keep = "tail",
    maxStderrChars,
    killTree: tree = true,
    killSignal = "SIGKILL",
    combine = false,
    killOnCap = false,
  } = opts;
  const errCap = maxStderrChars ?? maxChars;

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, aborted: true, truncated: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let abortFired = false;
    let settled = false;

    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd,
        env,
        detached: tree && process.platform !== "win32",
        stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false, truncated: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (child.pid !== undefined) untrackPid(child.pid);
    };
    const finish = (r: RunProcessResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };

    const kill = () => {
      if (child.pid === undefined) return;
      if (tree && process.platform === "win32") {
        try { spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", detached: true }); } catch { /* ignore */ }
        return;
      }
      if (tree) {
        try { process.kill(-child.pid, killSignal); return; } catch { /* fall through to direct kill */ }
      }
      try { child.kill(killSignal); } catch { /* already gone */ }
    };

    // Head cap: chunk granularity, like the old rg() loop — the first chunk
    // that reaches the cap is kept whole, later chunks are dropped.
    const addHead = (cur: string, text: string, cap: number): string => {
      if (cur.length >= cap) { truncated = true; return cur; }
      return cur + text;
    };
    const addTail = (cur: string, text: string, cap: number): string => {
      const next = cur + text;
      if (next.length <= cap) return next;
      truncated = true;
      return next.slice(-cap);
    };
    const add = (cur: string, text: string, cap: number): string =>
      keep === "head" ? addHead(cur, text, cap) : addTail(cur, text, cap);

    child.stdout?.on("data", (d: Buffer) => {
      stdout = add(stdout, d.toString("utf8"), maxChars);
      if (keep === "head" && killOnCap && truncated) kill();
    });
    if (combine) {
      child.stderr?.on("data", (d: Buffer) => {
        stdout = add(stdout, d.toString("utf8"), maxChars);
        if (keep === "head" && killOnCap && truncated) kill();
      });
    } else {
      child.stderr?.on("data", (d: Buffer) => {
        // stderr is head-kept without a kill: callers size it (e.g. 8KB) and
        // only read the first lines on failure.
        if (stderr.length >= errCap) return;
        stderr += d.toString("utf8");
      });
    }

    if (stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin);
    }

    if (child.pid !== undefined) trackPid(child.pid);

    const timer = timeoutMs !== undefined ? setTimeout(() => { timedOut = true; kill(); }, timeoutMs) : undefined;
    const onAbort = () => { abortFired = true; kill(); };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      finish({ code: null, signal: null, stdout, stderr, timedOut, aborted: abortFired, truncated, error: err.message });
    });
    child.on("close", (code, sig) => {
      finish({ code, signal: sig, stdout, stderr, timedOut, aborted: abortFired || (signal?.aborted ?? false), truncated });
    });
  });
}

// ── Long-lived spawn ──────────────────────────────────────────────────────────

/**
 * Spawn a child that outlives the call (background jobs). The pid is tracked
 * for shutdown cleanup until the child settles; output and lifetime stay with
 * the caller, exactly as a bare `spawn` with a detached group would.
 */
export function spawnTracked(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): ChildProcess {
  const child = spawn(file, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid !== undefined) trackPid(child.pid);
  const done = () => { if (child.pid !== undefined) untrackPid(child.pid); };
  child.on("close", done);
  child.on("error", done);
  return child;
}
