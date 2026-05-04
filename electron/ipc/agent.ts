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
 *   - Prompt is passed as a discrete args array element — never shell-interpolated.
 *   - cwd is validated as an accessible directory before spawn.
 */

import { ipcMain, dialog, BrowserWindow } from "electron";
import fs from "fs";
import path from "path";
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

  // ── Project code directory ───────────────────────────────────────────────

  ipcMain.handle("agent:saveProjectCodeDir", (_e, { projectId, dirPath }: { projectId: string; dirPath: string | null }) =>
    handle(() => q.setProjectCodeDirectory(db, projectId, dirPath))
  );

  // ── File system ──────────────────────────────────────────────────────────

  ipcMain.handle("agent:readDir", (_e, { dirPath }: { dirPath: string }) =>
    handle(() => {
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

  ipcMain.handle("agent:readFile", (_e, { filePath }: { filePath: string }) =>
    handle(() => fs.readFileSync(filePath, "utf-8"))
  );

  ipcMain.handle("agent:writeFile", (_e, { filePath, content }: { filePath: string; content: string }) =>
    handle(() => { fs.writeFileSync(filePath, content, "utf-8"); })
  );

  ipcMain.handle("agent:validateDirectory", (_e, { dirPath }: { dirPath: string }) =>
    handle(() => {
      try {
        const stat = fs.statSync(dirPath);
        return stat.isDirectory();
      } catch {
        return false;
      }
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
      // Security: validate cwd
      if (!isSafePath(payload.cwd) && process.platform !== "win32") {
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

      // Build args using {prompt} placeholder substitution.
      // If args contains {prompt}, substitute in-place (supports any CLI convention).
      // If args has no placeholder, append the prompt as a trailing positional only
      // when args is non-empty — otherwise launch interactively with no prompt arg.
      //
      // Examples:
      //   args = "run"               → ["run", "<prompt>"]   (OpenCode)
      //   args = "--message {prompt}"→ ["--message", "<prompt>"]  (custom)
      //   args = ""                  → []  (interactive TUI, no prompt injected)
      const PLACEHOLDER = "{prompt}";
      let allArgs: string[];
      if (agent.args.includes(PLACEHOLDER)) {
        // Replace placeholder token — keep surrounding tokens intact
        allArgs = agent.args
          .split(/\s+/)
          .flatMap((token) =>
            token === PLACEHOLDER
              ? [payload.prompt]
              : [token.replace(PLACEHOLDER, payload.prompt)]
          );
      } else if (agent.args.trim()) {
        // No placeholder: append prompt after the provided args
        allArgs = [...agent.args.trim().split(/\s+/), payload.prompt];
      } else {
        // Empty args: interactive mode — no prompt injected
        allArgs = [];
      }

      const pty = nodePty.spawn(agent.binaryPath, allArgs, {
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
