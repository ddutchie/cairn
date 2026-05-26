/**
 * Agent IPC — coding agent PTY session management.
 *
 * Registers all agent:* ipcMain.handle channels and manages node-pty
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

import { ipcMain, dialog, BrowserWindow } from "electron";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import type { Database } from "better-sqlite3";
import * as nodePty from "node-pty";
import * as q from "../db/queries";
import { newId } from "../db/utils";

type IPty = nodePty.IPty;

// ── Security ──────────────────────────────────────────────────────────────────

/** Absolute path with no shell metacharacters */
const SAFE_PATH_RE = /^\/[^;&|`$<>'"\\*?[\]{}!]+$/;
const SAFE_PATH_WIN_RE = /^[A-Za-z]:\\[^;&|`$<>'"*?[\]{}!]+$/;

export function isSafePath(p: string): boolean {
  return SAFE_PATH_RE.test(p) || SAFE_PATH_WIN_RE.test(p);
}

/**
 * Assert that `filePath` is safe and confined to one of the registered project
 * code directories. Throws if either check fails, which causes handle() to
 * return { error: "..." } to the renderer without crashing the main process.
 */
function assertWithinCodeDirectory(db: Database, filePath: string): void {
  if (!isSafePath(filePath)) {
    throw new Error(`Unsafe path: ${filePath}`);
  }
  const normalised = path.resolve(filePath);
  const codeDirs = db
    .prepare("SELECT code_directory FROM projects WHERE code_directory IS NOT NULL")
    .all() as { code_directory: string }[];
  const allowed = codeDirs.some(({ code_directory }) => {
    const dir = path.resolve(code_directory);
    return normalised === dir || normalised.startsWith(dir + path.sep);
  });
  if (!allowed) {
    throw new Error(`Path is outside any registered code directory: ${filePath}`);
  }
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

// ── Register handlers ─────────────────────────────────────────────────────────

export function registerAgentHandlers(db: Database): void {
  // ── Coding agent CRUD ────────────────────────────────────────────────────

  ipcMain.handle("agent:getCodingAgents", () =>
    handle(() => q.getCodingAgents(db))
  );

  ipcMain.handle("agent:saveCodingAgent", (_e, agent) =>
    handle(() => q.saveCodingAgent(db, agent))
  );

  ipcMain.handle("agent:deleteCodingAgent", (_e, { id }: { id: string }) =>
    handle(() => q.deleteCodingAgent(db, id))
  );

  ipcMain.handle("agent:setDefaultAgent", (_e, { id }: { id: string }) =>
    handle(() => q.setDefaultCodingAgent(db, id))
  );

  // Note: code_directory is now saved via db:project:update (the generic project
  // update IPC), which keeps it consistent with all other project field writes.

  // ── File system ──────────────────────────────────────────────────────────

  ipcMain.handle("agent:readDir", (_e, { dirPath }: { dirPath: string }) =>
    handle(() => {
      assertWithinCodeDirectory(db, dirPath);
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
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
          path: path.join(dirPath, e.name),
        }));
    })
  );

  ipcMain.handle("agent:searchFiles", (_e, { dirPath, query }: { dirPath: string; query: string }) =>
    handle(() => {
      assertWithinCodeDirectory(db, dirPath);
      const q = query.toLowerCase();
      const results: { name: string; path: string; relativePath: string }[] = [];
      const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "dist-electron", "dist-mcp", "dist-app", "out", ".cache", "coverage", "__pycache__", ".venv", "venv"]);
      const MAX_RESULTS = 50;

      function walk(dir: string, relDir: string) {
        if (results.length >= MAX_RESULTS) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
          if (results.length >= MAX_RESULTS) return;
          if (e.name.startsWith(".")) continue;
          const fullPath = path.join(dir, e.name);
          const relPath = relDir ? `${relDir}/${e.name}` : e.name;
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) walk(fullPath, relPath);
          } else {
            if (e.name.toLowerCase().includes(q)) {
              results.push({ name: e.name, path: fullPath, relativePath: relPath });
            }
          }
        }
      }

      walk(dirPath, "");
      return results;
    })
  );

  ipcMain.handle("agent:readFile", (_e, { filePath }: { filePath: string }) =>
    handle(() => {
      assertWithinCodeDirectory(db, filePath);
      return fs.readFileSync(filePath, "utf-8");
    })
  );

  ipcMain.handle("agent:readFileBase64", (_e, { filePath }: { filePath: string }) =>
    handle(() => {
      assertWithinCodeDirectory(db, filePath);
      const buf = fs.readFileSync(filePath);
      const ext = path.extname(filePath).slice(1).toLowerCase();
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

  ipcMain.handle("agent:writeFile", (_e, { filePath, content }: { filePath: string; content: string }) =>
    handle(() => {
      assertWithinCodeDirectory(db, filePath);
      fs.writeFileSync(filePath, content, "utf-8");
    })
  );

  ipcMain.handle("agent:validateDirectory", (_e, { dirPath }: { dirPath: string }) =>
    handle(() => {
      if (!isSafePath(dirPath)) return false;
      try {
        const stat = fs.statSync(dirPath);
        return stat.isDirectory();
      } catch {
        return false;
      }
    })
  );

  // ── Git diff ─────────────────────────────────────────────────────────────

  ipcMain.handle("agent:gitDiff", (_e, { cwd }: { cwd: string }) =>
    handle(() => {
      // Validate cwd exists and is a directory
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`Not a directory: ${cwd}`);
      }

      const parts: string[] = [];

      // ── 1. Tracked changes: staged + unstaged vs HEAD ────────────────────
      // Falls back to --cached only if HEAD doesn't exist yet (initial repo).
      let trackedResult = spawnSync("git", ["diff", "HEAD", "--unified=3"], {
        cwd, encoding: "utf-8", timeout: 10_000,
      });
      if (trackedResult.error) throw trackedResult.error;
      if (trackedResult.status !== 0) {
        // No HEAD yet — show only what's staged
        trackedResult = spawnSync("git", ["diff", "--cached", "--unified=3"], {
          cwd, encoding: "utf-8", timeout: 10_000,
        });
      }
      if (trackedResult.stdout) parts.push(trackedResult.stdout.trim());

      // ── 2. Untracked (new) files ─────────────────────────────────────────
      // git diff HEAD misses files that have never been git-added.
      // We enumerate them and synthesise a unified diff header so the
      // renderer's parse-diff library handles them identically to real hunks.
      const untrackedResult = spawnSync(
        "git", ["ls-files", "--others", "--exclude-standard"],
        { cwd, encoding: "utf-8", timeout: 10_000 },
      );
      if (!untrackedResult.error && untrackedResult.status === 0) {
        const untrackedFiles = (untrackedResult.stdout ?? "")
          .split("\n")
          .map((f) => f.trim())
          .filter(Boolean);

        for (const relPath of untrackedFiles) {
          const absPath = path.join(cwd, relPath);
          let content: string;
          try {
            content = fs.readFileSync(absPath, "utf-8");
          } catch {
            continue; // binary or unreadable — skip
          }

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
      }

      return parts.join("\n").trim();
    })
  );

  // ── Native pickers ───────────────────────────────────────────────────────

  ipcMain.handle("agent:pickDirectory", async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return { data: null };
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
    });
    return { data: result.canceled ? null : result.filePaths[0] };
  });

  ipcMain.handle("agent:pickFile", async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return { data: null };
    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
    });
    return { data: result.canceled ? null : result.filePaths[0] };
  });

  // ── PTY spawn ────────────────────────────────────────────────────────────

  ipcMain.handle("agent:spawn", async (event, payload: {
    agentId: string;
    projectId: string;
    cwd: string;
    prompt: string;
    taskId: string;
    taskTitle: string;
  }) => {
    return handle(async () => {
      // Security: validate cwd on all platforms
      if (!isSafePath(payload.cwd)) {
        throw new Error(`Invalid cwd path: ${payload.cwd}`);
      }
      const stat = fs.statSync(payload.cwd);
      if (!stat.isDirectory()) throw new Error(`cwd is not a directory: ${payload.cwd}`);

      // Load agent config
      const agent = q.getCodingAgentById(db, payload.agentId);
      if (!agent) throw new Error(`Agent not found: ${payload.agentId}`);

      // Security: validate binaryPath
      if (!isSafePath(agent.binaryPath)) {
        throw new Error(`Unsafe binaryPath: ${agent.binaryPath}`);
      }
      if (!fs.existsSync(agent.binaryPath)) {
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
        cwd: payload.cwd,
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

  ipcMain.handle("agent:spawnShell", async (event, payload: { cwd: string }) => {
    return handle(async () => {
      if (!isSafePath(payload.cwd)) throw new Error(`Invalid cwd: ${payload.cwd}`);
      const stat = fs.statSync(payload.cwd);
      if (!stat.isDirectory()) throw new Error(`cwd is not a directory: ${payload.cwd}`);

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
        attempts.push({ shell: defaultShell, cwd: payload.cwd, label: `default shell in cwd (${payload.cwd})` });
        attempts.push({ shell: defaultShell, cwd: homeDir, label: `default shell in homedir (${homeDir})` });
        if (defaultShell !== "cmd.exe") {
          attempts.push({ shell: "cmd.exe", cwd: payload.cwd, label: `cmd.exe in cwd (${payload.cwd})` });
          attempts.push({ shell: "cmd.exe", cwd: homeDir, label: `cmd.exe in homedir (${homeDir})` });
        }
        attempts.push({ shell: "powershell.exe", cwd: payload.cwd, label: `powershell.exe in cwd (${payload.cwd})` });
        attempts.push({ shell: "powershell.exe", cwd: homeDir, label: `powershell.exe in homedir (${homeDir})` });
      } else {
        attempts.push({ shell: defaultShell, cwd: payload.cwd, label: `default shell in cwd (${payload.cwd})` });
        attempts.push({ shell: defaultShell, cwd: homeDir, label: `default shell in homedir (${homeDir})` });
        if (defaultShell !== "/bin/zsh") {
          attempts.push({ shell: "/bin/zsh", cwd: payload.cwd, label: `/bin/zsh in cwd (${payload.cwd})` });
          attempts.push({ shell: "/bin/zsh", cwd: homeDir, label: `/bin/zsh in homedir (${homeDir})` });
        }
        if (defaultShell !== "/bin/bash") {
          attempts.push({ shell: "/bin/bash", cwd: payload.cwd, label: `/bin/bash in cwd (${payload.cwd})` });
          attempts.push({ shell: "/bin/bash", cwd: homeDir, label: `/bin/bash in homedir (${homeDir})` });
        }
        if (defaultShell !== "/bin/sh") {
          attempts.push({ shell: "/bin/sh", cwd: payload.cwd, label: `/bin/sh in cwd (${payload.cwd})` });
          attempts.push({ shell: "/bin/sh", cwd: homeDir, label: `/bin/sh in homedir (${homeDir})` });
        }
      }

      let pty;
      let lastError: Error | null = null;

      for (const attempt of attempts) {
        try {
          pty = nodePty.spawn(attempt.shell, [], {
            name: "xterm-256color",
            cols: 120,
            rows: 30,
            cwd:  attempt.cwd,
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

  ipcMain.handle("agent:input", (_e, { sessionId, data }: { sessionId: string; data: string }) =>
    handle(() => {
      const session = sessions.get(sessionId);
      if (session) session.pty.write(data);
    })
  );

  ipcMain.handle("agent:resize", (_e, { sessionId, cols, rows }: { sessionId: string; cols: number; rows: number }) =>
    handle(() => {
      const session = sessions.get(sessionId);
      if (session) session.pty.resize(cols, rows);
    })
  );

  ipcMain.handle("agent:kill", (_e, { sessionId }: { sessionId: string }) =>
    handle(() => {
      const session = sessions.get(sessionId);
      if (session) {
        session.pty.kill();
        sessions.delete(sessionId);
      }
    })
  );
}
