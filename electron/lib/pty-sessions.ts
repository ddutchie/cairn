/**
 * pty-sessions — shared node-pty session manager.
 *
 * Single owner of every PTY child process in the main process: the
 * renderer's bottom-terminal tabs (`agent:spawnShell` et al. in
 * `electron/ipc/agent.ts`) AND the dsh model terminal backend
 * (`electron/cordis/terminal-backend.ts`) both allocate through here, so
 * there is exactly one spawn/validation/kill implementation and one live
 * session table. Kill propagation is trivially bidirectional at this
 * level: `killPtySession` kills the OS process regardless of which side
 * created it, and an OS-side exit fires every subscriber's `onExit`
 * (each side marks its own state + drops the entry idempotently).
 *
 * node-pty is loaded LAZILY (`loadNodePty`) so importing this module never
 * touches the native binding — unit tests (vitest, plain Node) inject a
 * fake spawn via `__setPtySpawnForTest` and never load it. Production
 * callers use the default spawn, which `require("node-pty")`s at first
 * use (esbuild keeps it `--external`).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { Database } from "better-sqlite3";
import type * as nodePty from "node-pty";
import { newId } from "../db/utils";

/** Structural subset of node-pty's IPty used by every consumer here. */
export interface PtyHandle {
  readonly pid: number;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type PtySessionKind = "agent" | "shell" | "model";

export interface PtySessionEntry {
  pty: PtyHandle;
  agentId: string;
  taskId: string;
  kind: PtySessionKind;
  cwd: string;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

type SpawnFn = (file: string, args: string[], opts: PtySpawnOptions) => PtyHandle;

let spawnOverride: SpawnFn | undefined;

function loadNodePty(): SpawnFn {
  const req = createRequire(import.meta.url);
  const mod = req("node-pty") as typeof nodePty;
  return (file, args, opts) => mod.spawn(file, args, opts) as unknown as PtyHandle;
}

function spawnFn(): SpawnFn {
  return spawnOverride ?? loadNodePty();
}

/**
 * Raw spawn without validation or registration (agent-binary runs in
 * `electron/ipc/agent.ts` use this, then `registerPtySession`). Prefer
 * `spawnShellPty` for interactive shells.
 */
export function spawnRawPty(file: string, args: string[], opts: PtySpawnOptions): PtyHandle {
  return spawnFn()(file, args, opts);
}

/** Injectable PTY spawn for unit tests (never loads the native binding). */
export function __setPtySpawnForTest(fn: SpawnFn | undefined): void {
  spawnOverride = fn;
}

/** The single live session table (UI shells + agent runs + model PTYs). */
const sessions = new Map<string, PtySessionEntry>();

export function getPtySession(sessionId: string): PtySessionEntry | undefined {
  return sessions.get(sessionId);
}

export function hasPtySession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

export function registerPtySession(sessionId: string, entry: PtySessionEntry): void {
  sessions.set(sessionId, entry);
}

/** Remove without killing (exit handlers use this after the process is gone). */
export function unregisterPtySession(sessionId: string): void {
  sessions.delete(sessionId);
}

/** Test-only: best-effort kill of every live session + clear the table. */
export function __clearPtySessionsForTest(): void {
  for (const [, entry] of sessions) {
    try { entry.pty.kill(); } catch { /* already dead */ }
  }
  sessions.clear();
}

// ── Security (verbatim from electron/ipc/agent.ts) ────────────────────────────

/** Absolute path with no shell metacharacters */
const SAFE_PATH_RE = /^\/[^;&|`$<>'"\\*?[\]{}!]+$/;
const SAFE_PATH_WIN_RE = /^[A-Za-z]:\\[^;&|`$<>'"*?[\]{}!]+$/;

export function isSafePath(p: string): boolean {
  return SAFE_PATH_RE.test(p) || SAFE_PATH_WIN_RE.test(p);
}

export async function getRealPath(p: string, isWrite = false): Promise<string> {
  // If the path exists:
  try {
    const stat = await fs.promises.lstat(p);
    if (isWrite && stat.isSymbolicLink()) {
      throw new Error(`Symlinks are not allowed for write paths: ${p}`);
    }
    return await fs.promises.realpath(p);
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== "ENOENT") {
      throw err;
    }
  }
  // If it doesn't exist:
  const parent = path.dirname(p);
  try {
    const parentStat = await fs.promises.lstat(parent);
    if (isWrite && parentStat.isSymbolicLink()) {
      throw new Error(`Parent directory cannot be a symlink for write paths: ${parent}`);
    }
    const realParent = await fs.promises.realpath(parent);
    return path.join(realParent, path.basename(p));
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== "ENOENT") {
      throw err;
    }
  }
  return path.resolve(p);
}

/**
 * Assert that `filePath` is safe and confined to one of the registered project
 * code directories. Throws on failure; returns the normalised real path.
 */
export async function assertWithinCodeDirectory(
  db: Database,
  filePath: string,
  isWrite = false,
): Promise<string> {
  if (!isSafePath(filePath)) {
    throw new Error(`Unsafe path: ${filePath}`);
  }
  const normalised = await getRealPath(filePath, isWrite);
  const codeDirs = db
    .prepare("SELECT code_directory FROM projects WHERE code_directory IS NOT NULL")
    .all() as { code_directory: string }[];
  const checkAllowed = await Promise.all(
    codeDirs.map(async ({ code_directory }) => {
      try {
        const dir = await fs.promises.realpath(code_directory);
        return normalised === dir || normalised.startsWith(dir + path.sep);
      } catch {
        return false;
      }
    }),
  );
  const allowed = checkAllowed.some((val) => val === true);
  if (!allowed) {
    throw new Error(`Path is outside any registered code directory: ${filePath}`);
  }
  return normalised;
}

// ── Session operations ────────────────────────────────────────────────────────

export function writePtySession(sessionId: string, data: string): void {
  sessions.get(sessionId)?.pty.write(data);
}

export function resizePtySession(sessionId: string, cols: number, rows: number): void {
  sessions.get(sessionId)?.pty.resize(cols, rows);
}

/** Kill the OS process (if live) and drop the entry. Missing ids are a no-op. */
export function killPtySession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    try { session.pty.kill(); } catch { /* already dead */ }
    sessions.delete(sessionId);
  }
}

/** Subscribe to output; returns a disposer (no-op when the id is unknown). */
export function onPtySessionData(sessionId: string, cb: (data: string) => void): () => void {
  const session = sessions.get(sessionId);
  if (!session) return () => {};
  const sub = session.pty.onData(cb);
  return () => { try { sub.dispose(); } catch { /* noop */ } };
}

/** Subscribe to process exit; returns a disposer (no-op when unknown). */
export function onPtySessionExit(
  sessionId: string,
  cb: (e: { exitCode: number; signal?: number }) => void,
): () => void {
  const session = sessions.get(sessionId);
  if (!session) return () => {};
  const sub = session.pty.onExit(cb);
  return () => { try { sub.dispose(); } catch { /* noop */ } };
}

// ── Shell spawn (bottom terminal pane + model PTYs — one implementation) ─────
//
// Spawns the user's login shell ($SHELL / cmd.exe) directly in a given cwd.
// Moved verbatim from electron/ipc/agent.ts `agent:spawnShell` so UI tabs and
// model-owned PTYs share the fallback chain, the project-boundary filter,
// and the environment. Callers wire their own onData/onExit listeners.

export interface SpawnShellPtyOptions {
  agentId?: string;
  taskId?: string;
  kind?: PtySessionKind;
}

export async function spawnShellPty(
  db: Database,
  cwd: string,
  opts: SpawnShellPtyOptions = {},
): Promise<{ sessionId: string; cwd: string }> {
  const realCwd = await assertWithinCodeDirectory(db, cwd);
  try {
    const stat = await fs.promises.stat(realCwd);
    if (!stat.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
  } catch {
    throw new Error(`cwd is not a directory: ${cwd}`);
  }

  const defaultShell = process.platform === "win32"
    ? (process.env.COMSPEC || "cmd.exe")
    : (process.env.SHELL  || "/bin/zsh");

  interface SpawnAttempt {
    shell: string;
    cwd: string;
    label: string;
  }

  const homeDir = os.homedir();
  const attempts: SpawnAttempt[] = [];

  if (process.platform === "win32") {
    attempts.push({ shell: defaultShell, cwd: realCwd, label: `default shell in cwd (${cwd})` });
    attempts.push({ shell: defaultShell, cwd: homeDir, label: `default shell in homedir (${homeDir})` });
    if (defaultShell !== "cmd.exe") {
      attempts.push({ shell: "cmd.exe", cwd: realCwd, label: `cmd.exe in cwd (${cwd})` });
      attempts.push({ shell: "cmd.exe", cwd: homeDir, label: `cmd.exe in homedir (${homeDir})` });
    }
    attempts.push({ shell: "powershell.exe", cwd: realCwd, label: `powershell.exe in cwd (${cwd})` });
    attempts.push({ shell: "powershell.exe", cwd: homeDir, label: `powershell.exe in homedir (${homeDir})` });
  } else {
    attempts.push({ shell: defaultShell, cwd: realCwd, label: `default shell in cwd (${cwd})` });
    attempts.push({ shell: defaultShell, cwd: homeDir, label: `default shell in homedir (${homeDir})` });
    if (defaultShell !== "/bin/zsh") {
      attempts.push({ shell: "/bin/zsh", cwd: realCwd, label: `/bin/zsh in cwd (${cwd})` });
      attempts.push({ shell: "/bin/zsh", cwd: homeDir, label: `/bin/zsh in homedir (${homeDir})` });
    }
    if (defaultShell !== "/bin/bash") {
      attempts.push({ shell: "/bin/bash", cwd: realCwd, label: `/bin/bash in cwd (${cwd})` });
      attempts.push({ shell: "/bin/bash", cwd: homeDir, label: `/bin/bash in homedir (${homeDir})` });
    }
    if (defaultShell !== "/bin/sh") {
      attempts.push({ shell: "/bin/sh", cwd: realCwd, label: `/bin/sh in cwd (${cwd})` });
      attempts.push({ shell: "/bin/sh", cwd: homeDir, label: `/bin/sh in homedir (${homeDir})` });
    }
  }

  // Filter out any attempt whose cwd is outside the project boundaries
  const filterChecks = await Promise.all(
    attempts.map(async (attempt) => {
      try {
        await assertWithinCodeDirectory(db, attempt.cwd);
        return true;
      } catch {
        return false;
      }
    }),
  );
  const filteredAttempts = attempts.filter((_, idx) => filterChecks[idx]);

  if (filteredAttempts.length === 0) {
    throw new Error("No allowed shell spawn directory found within project boundaries.");
  }

  let pty: PtyHandle | undefined;
  let lastError: Error | null = null;
  let spawnedCwd = realCwd;

  for (const attempt of filteredAttempts) {
    try {
      const resolvedAttemptCwd = await getRealPath(attempt.cwd);
      pty = spawnFn()(attempt.shell, [], {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
        cwd:  resolvedAttemptCwd,
        env:  process.env as Record<string, string>,
      });
      spawnedCwd = resolvedAttemptCwd;
      console.log(`[agent] Successfully spawned ${attempt.label}`);
      break;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      console.warn(`[agent] Failed to spawn ${attempt.label}. Error:`, e);
    }
  }

  if (!pty) {
    console.error(`[agent] All spawning attempts failed. Last error:`, lastError);
    throw lastError || new Error("Failed to spawn terminal shell (all fallback paths exhausted).");
  }

  const sessionId = newId();
  sessions.set(sessionId, {
    pty,
    agentId: opts.agentId ?? "__shell__",
    taskId: opts.taskId ?? "__shell__",
    kind: opts.kind ?? "shell",
    cwd: spawnedCwd,
  });
  return { sessionId, cwd: spawnedCwd };
}
