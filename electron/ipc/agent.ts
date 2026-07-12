/**
 * Agent IPC — coding agent PTY session management.
 *
 * Registers all agent:* registerIpcHandle channels and manages node-pty
 * child processes via AgentSessionManager. Streams PTY data to the
 * renderer via webContents.send.
 *
 * All handlers use the existing handle() wrapper from handlers.ts for
 * consistent { data } | { error } responses.
 *
 * Security:
 *   - binaryPath is validated (absolute, no shell metacharacters) before spawn.
 *   - Prompt is single-quote escaped and passed as a CLI argument via
 *     `exec sh -c '...'`, never shell-interpolated. `exec` replaces sh so
 *     it cannot echo stray escape sequences back to the PTY.
 *   - cwd is validated as an accessible directory before spawn.
 */

import { dialog, BrowserWindow } from "electron";
import { registerIpcHandle } from "./registry";

import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import type { Database } from "better-sqlite3";
import * as nodePty from "node-pty";
import * as q from "../db/queries";
import { newId } from "../db/utils";
import { indexCodebase, reindexFile } from "../lib/codebase-index";

type IPty = nodePty.IPty;

// ── Security ──────────────────────────────────────────────────────────────────

/** Absolute path with no shell metacharacters */
const SAFE_PATH_RE = /^\/[^;&|`$<>'"\\*?[\]{}!]+$/;
const SAFE_PATH_WIN_RE = /^[A-Za-z]:\\[^;&|`$<>'"*?[\]{}!]+$/;

export function isSafePath(p: string): boolean {
  return SAFE_PATH_RE.test(p) || SAFE_PATH_WIN_RE.test(p);
}

async function getRealPath(p: string, isWrite = false): Promise<string> {
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
 * code directories. Throws if either check fails, which causes handle() to
 * return { error: "..." } to the renderer without crashing the main process.
 */
async function assertWithinCodeDirectory(db: Database, filePath: string, isWrite = false): Promise<string> {
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
    })
  );
  const allowed = checkAllowed.some((val) => val === true);
  if (!allowed) {
    throw new Error(`Path is outside any registered code directory: ${filePath}`);
  }
  return normalised;
}

// ── Session map ───────────────────────────────────────────────────────────────

interface PtySession {
  pty: IPty;
  agentId: string;
  taskId: string;
}

const sessions = new Map<string, PtySession>();

// ── IPC result wrapper (matches handlers.ts pattern) ─────────────────────────

function handle<T>(fn: () => T | Promise<T>): Promise<{ data: T } | { error: string }> {
  return Promise.resolve()
    .then(() => fn())
    .then((data) => ({ data }))
    .catch((err: unknown) => ({ error: String(err) }));
}

function execGit(args: string[], cwd: string, timeout = 10_000): Promise<{ stdout: string; stderr: string; error?: Error | null; status: number }> {
  return new Promise((resolve) => {
    const maxBuffer = 20 * 1024 * 1024; // 20MB
    execFile("git", args, { cwd, encoding: "utf-8", timeout, maxBuffer }, (error, stdout, stderr) => {
      const code = error ? (error as { code?: number | string }).code : 0;
      const status = typeof code === "number" ? code : (error ? 1 : 0);
      resolve({
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        error,
        status,
      });
    });
  });
}

// ── Register handlers ─────────────────────────────────────────────────────────

export function registerAgentHandlers(db: Database): void {
  // ── Coding agent CRUD ────────────────────────────────────────────────────

  registerIpcHandle("agent:getCodingAgents", () =>
    handle(() => q.getCodingAgents(db))
  );

  registerIpcHandle("agent:saveCodingAgent", (_e, agent: Parameters<typeof q.saveCodingAgent>[1]) =>
    handle(() => q.saveCodingAgent(db, agent))
  );

  registerIpcHandle("agent:deleteCodingAgent", (_e, { id }: { id: string }) =>
    handle(() => q.deleteCodingAgent(db, id))
  );

  registerIpcHandle("agent:setDefaultAgent", (_e, { id }: { id: string }) =>
    handle(() => q.setDefaultCodingAgent(db, id))
  );

  // Note: code_directory is now saved via db:project:update (the generic project
  // update IPC), which keeps it consistent with all other project field writes.

  // ── File system ──────────────────────────────────────────────────────────

  registerIpcHandle("agent:readDir", (_e, { dirPath }: { dirPath: string }) =>
    handle(async () => {
      const realPath = await assertWithinCodeDirectory(db, dirPath);
      const entries = await fs.promises.readdir(realPath, { withFileTypes: true });
      return entries
        .filter((e) => !e.name.startsWith("."))
        .sort((a, b) => {
          // Directories first, then files, alphabetical within each group
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "dir" : "file",
          path: path.join(realPath, e.name),
        }));
    })
  );

  registerIpcHandle("agent:searchFiles", (_e, { dirPath, query }: { dirPath: string; query: string }) =>
    handle(async () => {
      const realPath = await assertWithinCodeDirectory(db, dirPath);
      const q = query.toLowerCase();
      const results: { name: string; path: string; relativePath: string }[] = [];
      const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "dist-electron", "dist-mcp", "dist-app", "out", ".cache", "coverage", "__pycache__", ".venv", "venv"]);
      const MAX_RESULTS = 50;

      async function walk(dir: string, relDir: string) {
        if (results.length >= MAX_RESULTS) return;
        let entries: fs.Dirent[];
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
          if (results.length >= MAX_RESULTS) return;
          if (e.name.startsWith(".")) continue;
          const fullPath = path.join(dir, e.name);
          const relPath = relDir ? `${relDir}/${e.name}` : e.name;
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) await walk(fullPath, relPath);
          } else {
            if (e.name.toLowerCase().includes(q)) {
              results.push({ name: e.name, path: fullPath, relativePath: relPath });
            }
          }
        }
      }

      await walk(realPath, "");
      return results;
    })
  );

  registerIpcHandle("agent:readFile", (_e, { filePath }: { filePath: string }) =>
    handle(async () => {
      const realPath = await assertWithinCodeDirectory(db, filePath);
      return fs.promises.readFile(realPath, "utf-8");
    })
  );

  registerIpcHandle("agent:readFileBase64", (_e, { filePath }: { filePath: string }) =>
    handle(async () => {
      const realPath = await assertWithinCodeDirectory(db, filePath);
      const buf = await fs.promises.readFile(realPath);
      const ext = path.extname(realPath).slice(1).toLowerCase();
      const mime =
        ext === "svg" ? "image/svg+xml" :
        ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
        ext === "png" ? "image/png" :
        ext === "gif" ? "image/gif" :
        ext === "webp" ? "image/webp" :
        ext === "ico" ? "image/x-icon" :
        ext === "bmp" ? "image/bmp" :
        ext === "avif" ? "image/avif" :
        ext === "tif" || ext === "tiff" ? "image/tiff" :
        "application/octet-stream";
      return `data:${mime};base64,${buf.toString("base64")}`;
    })
  );

  registerIpcHandle("agent:writeFile", (_e, { filePath, content }: { filePath: string; content: string }) =>
    handle(async () => {
      const realPath = await assertWithinCodeDirectory(db, filePath, true);
      await fs.promises.writeFile(realPath, content, "utf-8");
    })
  );

  registerIpcHandle("agent:validateDirectory", (_e, { dirPath }: { dirPath: string }) =>
    handle(async () => {
      if (!isSafePath(dirPath)) return false;
      try {
        const stat = await fs.promises.stat(dirPath);
        return stat.isDirectory();
      } catch {
        return false;
      }
    })
  );

  // ── Codebase index (Architecture tab) ────────────────────────────────────
  // Read-only views over the semantic codebase index (codebase_files/symbols/
  // relations) so the renderer can visualise what the agent has indexed. The
  // folder is validated against the project's code_directory before use.

  registerIpcHandle("agent:codebaseOverview", (_e, { folder }: { folder: string }) =>
    handle(async () => {
      const realPath = await assertWithinCodeDirectory(db, folder);
      return q.getCodebaseOverview(db, realPath);
    })
  );

  registerIpcHandle("agent:codebaseGraph", (_e, { folder }: { folder: string }) =>
    handle(async () => {
      const realPath = await assertWithinCodeDirectory(db, folder);
      return q.getCodebaseGraph(db, realPath);
    })
  );

  registerIpcHandle("agent:codebaseModuleGraph", (_e, { folder, depth }: { folder: string; depth?: number }) =>
    handle(async () => {
      const realPath = await assertWithinCodeDirectory(db, folder);
      return q.getCodebaseModuleGraph(db, realPath, depth ?? 1);
    })
  );

  registerIpcHandle("agent:codebaseFileSymbols", (_e, { filePath }: { filePath: string }) =>
    handle(async () => {
      const realPath = await assertWithinCodeDirectory(db, filePath);
      return q.getCodebaseFileSymbols(db, realPath);
    })
  );

  registerIpcHandle("agent:codebaseRelations", (_e, { name, folder }: { name: string; folder?: string }) =>
    handle(async () => {
      const scoped = folder ? await assertWithinCodeDirectory(db, folder) : undefined;
      return q.getCodebaseRelations(db, name, scoped);
    })
  );

  registerIpcHandle("agent:codebaseReindex", (_e, { folder }: { folder: string }) =>
    handle(async () => {
      const realPath = await assertWithinCodeDirectory(db, folder);
      await indexCodebase(db, realPath);
      return q.getCodebaseOverview(db, realPath);
    })
  );

  registerIpcHandle("agent:codebaseReindexFile", (_e, { folder, filePath }: { folder: string; filePath: string }) =>
    handle(async () => {
      const realFolder = await assertWithinCodeDirectory(db, folder);
      const realFile = await assertWithinCodeDirectory(db, filePath);
      return reindexFile(db, realFolder, realFile);
    })
  );

  // ── Git diff ─────────────────────────────────────────────────────────────

  registerIpcHandle("agent:gitDiff", (_e, { cwd }: { cwd: string }) =>
    handle(async () => {
      // Validate cwd is within project code directory boundaries and get real path
      const realPath = await assertWithinCodeDirectory(db, cwd);

      // Validate realPath exists and is a directory
      try {
        const stat = await fs.promises.stat(realPath);
        if (!stat.isDirectory()) {
          throw new Error(`Not a directory: ${realPath}`);
        }
      } catch {
        throw new Error(`Not a directory: ${realPath}`);
      }

      const parts: string[] = [];

      // ── 1. Tracked changes: staged + unstaged vs HEAD ────────────────────
      // Falls back to --cached only if HEAD doesn't exist yet (initial repo).
      let trackedResult = await execGit(["diff", "HEAD", "--unified=3"], realPath);
      if (trackedResult.status !== 0) {
        // No HEAD yet — show only what's staged
        trackedResult = await execGit(["diff", "--cached", "--unified=3"], realPath);
      }
      if (trackedResult.status !== 0) {
        const errMsg = trackedResult.stderr.trim() || (trackedResult.error ? trackedResult.error.message : `git diff failed with exit code ${trackedResult.status}`);
        throw new Error(errMsg);
      }
      if (trackedResult.stdout) parts.push(trackedResult.stdout.trim());

      // ── 2. Untracked (new) files ─────────────────────────────────────────
      // git diff HEAD misses files that have never been git-added.
      // We enumerate them and synthesise a unified diff header so the
      // renderer's parse-diff library handles them identically to real hunks.
      const untrackedResult = await execGit(
        ["ls-files", "-z", "--others", "--exclude-standard"],
        realPath
      );
      if (untrackedResult.status !== 0) {
        const errMsg = untrackedResult.stderr.trim() || (untrackedResult.error ? untrackedResult.error.message : `git ls-files failed with exit code ${untrackedResult.status}`);
        throw new Error(errMsg);
      }

      const untrackedFiles = (untrackedResult.stdout ?? "")
        .split("\0")
        .filter(Boolean);

      const CONCURRENCY = 10;
      const readResults: ({ relPath: string; content: string } | null)[] = [];
      for (let i = 0; i < untrackedFiles.length; i += CONCURRENCY) {
        const chunk = untrackedFiles.slice(i, i + CONCURRENCY);
        const chunkPromises = chunk.map(async (relPath) => {
          const absPath = path.join(realPath, relPath);
          try {
            const stat = await fs.promises.lstat(absPath);
            if (!stat.isFile() || stat.size > 1024 * 1024) {
              return null; // non-regular file or oversized (>1MB) — skip
            }
            const content = await fs.promises.readFile(absPath, "utf-8");
            return { relPath, content };
          } catch {
            return null; // binary or unreadable — skip
          }
        });
        const chunkResults = await Promise.all(chunkPromises);
        readResults.push(...chunkResults);
      }

      for (const res of readResults) {
        if (!res) continue;
        const { relPath, content } = res;

        // Synthesise a unified diff:
        //   diff --git a/<file> b/<file>
        //   new file mode 100644
        //   --- /dev/null
        //   +++ b/<file>
        //   @@ -0,0 +1,N @@
        //   +<each line>
        const lines = content.split("\n");
        // Drop trailing empty string from trailing newline
        if (lines[lines.length - 1] === "") lines.pop();
        const hunk = lines.map((l) => `+${l}`).join("\n");
        const synth = [
          `diff --git a/${relPath} b/${relPath}`,
          `new file mode 100644`,
          `index 0000000..0000000`,
          `--- /dev/null`,
          `+++ b/${relPath}`,
          `@@ -0,0 +1,${lines.length} @@`,
          hunk,
        ].join("\n");
        parts.push(synth);
      }

      return parts.join("\n").trim();
    })
  );

  // ── Native pickers ───────────────────────────────────────────────────────

  registerIpcHandle("agent:pickDirectory", async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return { data: null };
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
    });
    return { data: result.canceled ? null : result.filePaths[0] };
  });

  registerIpcHandle("agent:pickFile", async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return { data: null };
    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
    });
    return { data: result.canceled ? null : result.filePaths[0] };
  });

  // ── PTY spawn ────────────────────────────────────────────────────────────

  registerIpcHandle("agent:spawn", async (event, payload: {
    agentId: string;
    projectId: string;
    cwd: string;
    prompt: string;
    taskId: string;
    taskTitle: string;
  }) => {
    return handle(async () => {
      // Security: assert project code directory boundaries and validate cwd
      const realCwd = await assertWithinCodeDirectory(db, payload.cwd);
      try {
        const stat = await fs.promises.stat(realCwd);
        if (!stat.isDirectory()) throw new Error(`cwd is not a directory: ${payload.cwd}`);
      } catch {
        throw new Error(`cwd is not a directory: ${payload.cwd}`);
      }

      // Load agent config
      const agent = q.getCodingAgentById(db, payload.agentId);
      if (!agent) throw new Error(`Agent not found: ${payload.agentId}`);

      // Security: validate binaryPath
      if (!isSafePath(agent.binaryPath)) {
        throw new Error(`Unsafe binaryPath: ${agent.binaryPath}`);
      }
      try {
        await fs.promises.access(agent.binaryPath, fs.constants.F_OK);
      } catch {
        throw new Error(`Agent binary not found: ${agent.binaryPath}`);
      }

      // Build the spawn command.
      //
      // We always use `exec sh -c '...'` when a prompt is involved so that:
      //   1. The prompt is passed as a properly single-quoted shell argument —
      //      safe for any length, newlines, colons, etc.
      //   2. `exec` replaces sh with the agent binary, so sh is never sitting
      //      on the PTY echoing stray mouse-tracking escape sequences back to
      //      the terminal.
      //
      // Args field conventions (examples):
      //   args = ""
      //     → interactive TUI, spawn binary directly with no args
      //   args = "{prompt}"
      //     → exec binary 'prompt text'
      //        opencode: first positional pre-fills the TUI message
      //   args = "--prompt {prompt}"
      //     → exec binary --prompt 'prompt text'
      //        opencode: explicit flag, identical result to above
      //   args = "--message {prompt}"
      //     → exec binary --message 'prompt text'
      //        claude / aider style
      //   args = "run"  (no placeholder)
      //     → exec binary run 'prompt text'   (prompt appended as last arg)
      //
      // Single-quote escaping: replace every ' in the value with '\''
      // (end quote, escaped quote, reopen quote) — works in all POSIX shells.

      const shellEscape = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

      let spawnBin: string;
      let spawnArgs: string[];

      const trimmedArgs = agent.args.trim();

      if (!trimmedArgs) {
        // Empty args → pure interactive TUI, spawn binary directly
        spawnBin = agent.binaryPath;
        spawnArgs = [];
      } else {
        // Build token list, substituting {prompt} in-place or appending at end.
        // Check for the placeholder as a substring first (handles --flag={prompt}),
        // then replace it within each token rather than requiring an exact match.
        const PLACEHOLDER = "{prompt}";
        const hasPlaceholder = trimmedArgs.includes(PLACEHOLDER);
        const tokens = trimmedArgs.split(/\s+/).filter(Boolean);

        const finalTokens = hasPlaceholder
          ? tokens.map((t) => t.includes(PLACEHOLDER) ? t.replace(PLACEHOLDER, payload.prompt) : t)
          : [...tokens, payload.prompt];

        // Build: exec binary arg1 arg2 'prompt...'
        // exec replaces sh so it never sits on the PTY after the binary starts.
        const shellCmd = [
          "exec",
          shellEscape(agent.binaryPath),
          ...finalTokens.slice(0, finalTokens.length - 1).map(shellEscape),
          shellEscape(finalTokens[finalTokens.length - 1]),
        ].join(" ");

        if (process.platform === "win32") {
          spawnBin = "cmd.exe";
          spawnArgs = ["/c", shellCmd.replace(/^exec /, "")]; // cmd has no exec
        } else {
          spawnBin = "/bin/sh";
          spawnArgs = ["-c", shellCmd];
        }
      }

      const pty = nodePty.spawn(spawnBin, spawnArgs, {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
        cwd: realCwd,
        env: process.env as Record<string, string>,
      });

      const sessionId = newId();
      sessions.set(sessionId, { pty, agentId: payload.agentId, taskId: payload.taskId });

      const webContents = event.sender;

      pty.onData((data: string) => {
        if (!webContents.isDestroyed()) {
          webContents.send("agent:data", { sessionId, data });
        }
      });

      pty.onExit(({ exitCode }: { exitCode: number }) => {
        sessions.delete(sessionId);
        if (!webContents.isDestroyed()) {
          webContents.send("agent:exit", { sessionId, exitCode });
        }
      });

      // Kill this session if the renderer that spawned it is destroyed
      // (e.g. window reload) so we never orphan live PTY processes.
      webContents.once("destroyed", () => {
        const s = sessions.get(sessionId);
        if (s) { try { s.pty.kill(); } catch { /* already dead */ } sessions.delete(sessionId); }
      });

      return { sessionId };
    });
  });

  // ── Shell spawn (bottom terminal pane — no agent binary required) ────────
  //
  // Spawns the user's login shell ($SHELL / cmd.exe) directly in a given cwd.
  // Uses the same PTY session map so agent:input / agent:resize / agent:kill
  // / agent:data / agent:exit all work identically.

  registerIpcHandle("agent:spawnShell", async (event, payload: { cwd: string }) => {
    return handle(async () => {
      const realCwd = await assertWithinCodeDirectory(db, payload.cwd);
      try {
        const stat = await fs.promises.stat(realCwd);
        if (!stat.isDirectory()) throw new Error(`cwd is not a directory: ${payload.cwd}`);
      } catch {
        throw new Error(`cwd is not a directory: ${payload.cwd}`);
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
        attempts.push({ shell: defaultShell, cwd: realCwd, label: `default shell in cwd (${payload.cwd})` });
        attempts.push({ shell: defaultShell, cwd: homeDir, label: `default shell in homedir (${homeDir})` });
        if (defaultShell !== "cmd.exe") {
          attempts.push({ shell: "cmd.exe", cwd: realCwd, label: `cmd.exe in cwd (${payload.cwd})` });
          attempts.push({ shell: "cmd.exe", cwd: homeDir, label: `cmd.exe in homedir (${homeDir})` });
        }
        attempts.push({ shell: "powershell.exe", cwd: realCwd, label: `powershell.exe in cwd (${payload.cwd})` });
        attempts.push({ shell: "powershell.exe", cwd: homeDir, label: `powershell.exe in homedir (${homeDir})` });
      } else {
        attempts.push({ shell: defaultShell, cwd: realCwd, label: `default shell in cwd (${payload.cwd})` });
        attempts.push({ shell: defaultShell, cwd: homeDir, label: `default shell in homedir (${homeDir})` });
        if (defaultShell !== "/bin/zsh") {
          attempts.push({ shell: "/bin/zsh", cwd: realCwd, label: `/bin/zsh in cwd (${payload.cwd})` });
          attempts.push({ shell: "/bin/zsh", cwd: homeDir, label: `/bin/zsh in homedir (${homeDir})` });
        }
        if (defaultShell !== "/bin/bash") {
          attempts.push({ shell: "/bin/bash", cwd: realCwd, label: `/bin/bash in cwd (${payload.cwd})` });
          attempts.push({ shell: "/bin/bash", cwd: homeDir, label: `/bin/bash in homedir (${homeDir})` });
        }
        if (defaultShell !== "/bin/sh") {
          attempts.push({ shell: "/bin/sh", cwd: realCwd, label: `/bin/sh in cwd (${payload.cwd})` });
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
        })
      );
      const filteredAttempts = attempts.filter((_, idx) => filterChecks[idx]);

      if (filteredAttempts.length === 0) {
        throw new Error("No allowed shell spawn directory found within project boundaries.");
      }

      let pty;
      let lastError: Error | null = null;

      for (const attempt of filteredAttempts) {
        try {
          const resolvedAttemptCwd = await getRealPath(attempt.cwd);
          pty = nodePty.spawn(attempt.shell, [], {
            name: "xterm-256color",
            cols: 120,
            rows: 30,
            cwd:  resolvedAttemptCwd,
            env:  process.env as Record<string, string>,
          });
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
      // agentId / taskId not meaningful for shell sessions — use sentinel values
      sessions.set(sessionId, { pty, agentId: "__shell__", taskId: "__shell__" });

      const webContents = event.sender;

      pty.onData((data: string) => {
        if (!webContents.isDestroyed()) webContents.send("agent:data", { sessionId, data });
      });

      pty.onExit(({ exitCode }: { exitCode: number }) => {
        sessions.delete(sessionId);
        if (!webContents.isDestroyed()) webContents.send("agent:exit", { sessionId, exitCode });
      });

      webContents.once("destroyed", () => {
        const s = sessions.get(sessionId);
        if (s) { try { s.pty.kill(); } catch { /* already dead */ } sessions.delete(sessionId); }
      });

      return { sessionId };
    });
  });

  // ── PTY input / resize / kill ────────────────────────────────────────────

  registerIpcHandle("agent:input", (_e, { sessionId, data }: { sessionId: string; data: string }) =>
    handle(() => {
      const session = sessions.get(sessionId);
      if (session) session.pty.write(data);
    })
  );

  registerIpcHandle("agent:resize", (_e, { sessionId, cols, rows }: { sessionId: string; cols: number; rows: number }) =>
    handle(() => {
      const session = sessions.get(sessionId);
      if (session) session.pty.resize(cols, rows);
    })
  );

  registerIpcHandle("agent:kill", (_e, { sessionId }: { sessionId: string }) =>
    handle(() => {
      const session = sessions.get(sessionId);
      if (session) {
        session.pty.kill();
        sessions.delete(sessionId);
      }
    })
  );
}
