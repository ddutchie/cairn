/**
 * Cairn — IPC handler registry (orchestrator).
 *
 * Previously a 1054-line god-file mixing 7 domains + 3 large inline templates
 * (the PDF HTML template, the OG scraper, and the `db:flow:node:summarize` BFS).
 * Split per-domain in P2 of the cleanup plan — this file now just calls each
 * module's `registerXxxHandlers()` function.
 *
 * Public exports preserved for `main.ts`:
 *   - `DbContext` (re-exported from `./result-helpers`)
 *   - `registerIpcHandlers(ctx)` — db + chat + flow + ai + llama + graph channels.
 *     Registered from `main.ts:188`.
 *   - `registerAppHandlers(ctx, userDataPath, updateTrayBadge, onReinitialise, onBadgeClear)`
 *     — app-level channels (workspace setup, theme, mobile, PDF, URL fetch,
 *     migrations, settings, updater). Registered from `main.ts:286`.
 *
 * Channel naming convention: "db:<entity>:<action>" for DB CRUD; "app:<feature>"
 * for app-level; "<feature>:<action>" for everything else (`llama:*`, `mobile:*`,
 * `ai:*`, `updater:*`, `mcp:*`).
 */

import { app, dialog } from "electron";
import fs from "fs";
import path from "path";

import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
export { type DbContext } from "./result-helpers";

// Per-domain registrars
import { registerDbHandlers } from "./db-handlers";
import { registerChatDbHandlers } from "./chat-db-handlers";
import { registerPiSessionHandlers } from "./pi-session-handlers";
import { registerFlowHandlers } from "./flow-handlers";
import { registerAiHandlers } from "./ai-handlers";
import { registerLlamaHandlers } from "./llama-handlers";
import { registerGraphHandlers } from "./graph-handlers";
import { registerEmbeddingsHandlers } from "./embeddings-handlers";
import { registerRuntimeHandlers } from "./runtime-handlers";
import { registerChatHandler } from "./chat";
import { registerPdfExportHandler } from "./pdf-export";
import { registerMarkdownExportHandler } from "./markdown-export";
import { registerUrlMetadataHandler } from "./url-metadata";
import { registerMobileHandlers } from "./mobile-handlers";
import { registerMigrationHandlers } from "./migration-handlers";
import { registerSettingsHandlers } from "./settings-handlers";

import { readWorkspaceConfig, writeWorkspaceConfig } from "../workspace-config";
import { markMcpNotificationsRead } from "../db/queries";
import * as q from "../db/queries";
import { writeNoteFile, deleteNoteFile } from "../notes-files";
import { suppressNextChange } from "../file-watcher";
import { getProjectName } from "./result-helpers";
import { broadcastEvent } from "./registry";

/**
 * Register the DB + chat + flow + ai + llama + graph IPC handlers.
 * Called from main.ts once the DB context is established.
 */
export function registerIpcHandlers(ctx: DbContext): void {
  registerDbHandlers(ctx);
  registerChatHandler(ctx.db, ctx.workspacePath, ctx.getWin);
  registerChatDbHandlers(ctx);
  registerPiSessionHandlers(ctx);
  registerFlowHandlers(ctx);
  registerAiHandlers(ctx);
  registerLlamaHandlers(ctx);
  registerGraphHandlers(ctx);
  registerEmbeddingsHandlers(ctx);
  registerRuntimeHandlers(ctx);
}

/**
 * Register app-level IPC handlers (workspace setup, theme, mobile, PDF,
 * URL fetch, migrations, settings, updater). Called from main.ts after the
 * workspace is selected.
 */
export function registerAppHandlers(
  ctx: DbContext,
  userDataPath: string,
  updateTrayBadge: (count: number) => void,
  onReinitialise?: (newWorkspacePath: string) => Promise<void>,
  /** Called when the badge is cleared from the renderer — resets poller count too. */
  onBadgeClear?: () => void,
): void {
  // ── Workspace folder selection / setup ────────────
  registerIpcHandle("app:selectWorkspaceFolder", async () => {
    return handle(async () => {
      const result = await dialog.showOpenDialog({
        // title renders on all platforms; message is macOS-only and silently ignored on Windows
        title: "Select a folder where Cairn will store your notes and database.",
        buttonLabel: "Use This Folder",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const chosen = result.filePaths[0];
      writeWorkspaceConfig(userDataPath, chosen);
      return chosen;
    });
  });

  registerIpcHandle("app:getWorkspacePath", () => handle(() =>
    readWorkspaceConfig(userDataPath)?.workspacePath ?? null
  ));

  registerIpcHandle("app:needsWorkspaceSetup", () => handle(() =>
    readWorkspaceConfig(userDataPath) === null
  ));

  registerIpcHandle("app:setTheme", (_e, theme: string) => handle(() => {
    const themeFile = path.join(userDataPath, "theme.json");
    fs.writeFileSync(themeFile, JSON.stringify({ theme }), "utf8");
    // On Windows, update the native title bar overlay to match the new theme.
    // Use --surface values (not backgroundColor) to match TitleBar's bg-[var(--surface)].
    // height:39 not 40 — Windows 1px window border makes 40 clip the border-b below the bar.
    if (process.platform === "win32") {
      const activeWin = ctx.getWin();
      if (activeWin && !activeWin.isDestroyed()) {
        const surface = theme === "light" ? "#ffffff" : "#141414";
        activeWin.setTitleBarOverlay({ color: surface, symbolColor: "#888888", height: 39 });
      }
    }
  }));

  registerIpcHandle("app:initWorkspace", (_e, { workspacePath: newPath }: { workspacePath: string }) => handle(async () => {
    writeWorkspaceConfig(userDataPath, newPath);
    fs.mkdirSync(newPath, { recursive: true });
    if (onReinitialise) {
      await onReinitialise(newPath);
    }
    return { ok: true };
  }));

  // ── App paths (for MCP config generation) ─────────
  registerIpcHandle("app:mcpServerPath", () => handle(() => {
    const appPath = app.getAppPath();
    const unpackedPath = appPath.replace(/\.asar$/, ".asar.unpacked");
    // Every packaged app ships exactly ONE MCP binary for its arch, named
    // canonically per platform (the afterPack hook renames the arch-specific
    // macOS build to `cairn-mcp`). So this is a straight platform switch.
    const binaryName = process.platform === "win32" ? "cairn-mcp.exe"
      : process.platform === "linux" ? "cairn-mcp-linux"
        : "cairn-mcp";
    return path.join(unpackedPath, "dist-mcp", binaryName);
  }));

  // ── Latest changelog ───────────────────────────────
  registerIpcHandle("app:latestChangelog", () => handle(() => {
    // In dev, app.getAppPath() points to dist-electron/ — walk up to repo root instead.
    // In packaged builds, changelogs/ is bundled inside the asar alongside dist-electron/.
    const changelogsDir = app.isPackaged
      ? path.join(app.getAppPath(), "changelogs")
      : path.join(__dirname, "..", "changelogs");
    if (!fs.existsSync(changelogsDir)) return null;
    const files = fs.readdirSync(changelogsDir)
      .filter((f) => /^v\d+\.\d+\.\d+\.md$/.test(f));
    if (files.length === 0) return null;
    // Sort by semver descending and pick the highest
    files.sort((a, b) => {
      const parse = (f: string) => f.replace(/^v/, "").replace(/\.md$/, "").split(".").map(Number);
      const [aMaj, aMin, aPatch] = parse(a);
      const [bMaj, bMin, bPatch] = parse(b);
      return bMaj - aMaj || bMin - aMin || bPatch - aPatch;
    });
    return fs.readFileSync(path.join(changelogsDir, files[0]), "utf8");
  }));

  // ── Reset all data — wipe every table then relaunch ──────────────────────
  registerIpcHandle("app:reset", () => handle(() => {
    const tables = ["chat_messages", "chat_threads", "mcp_notifications", "task_cards", "board_columns", "notes", "tags", "projects", "workspaces"];
    for (const t of tables) {
      ctx.db.prepare(`DELETE FROM ${t}`).run();
    }
    app.relaunch();
    app.quit();
  }));

  // ── Relaunch (used after workspace init to re-open DB at correct path) ──
  registerIpcHandle("app:relaunch", () => handle(() => {
    app.relaunch();
    app.quit();
  }));

  // ── Auto-updater install ───────────────────────────
  registerIpcHandle("updater:install", () => handle(() => {
    // Dynamically require to avoid issues in dev where autoUpdater isn't active.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require("electron-updater");
    autoUpdater.quitAndInstall();
  }));

  // ── MCP notification handler ───────────────────────
  registerIpcHandle("mcp:markNotificationsRead", () => handle(() => {
    markMcpNotificationsRead(ctx.db);
    updateTrayBadge(0);
    onBadgeClear?.();
  }));

  // ── Delegated registrars ──────────────────────────
  // The mobile handlers need `ctx` (for the mobile server's DB access) and `userDataPath`.
  registerMobileHandlers(ctx, userDataPath);

  // PDF export + URL metadata (each module owns its own channel registration).
  registerPdfExportHandler(ctx);
  registerMarkdownExportHandler(ctx);
  registerUrlMetadataHandler();

  // Migration tool (Obsidian → Cairn import).
  registerMigrationHandlers(ctx);

  // Cached AI/agent/theme/fontScale settings.
  registerSettingsHandlers();

  // Desktop sync (folder connect + manual sync). Registered here so it shares
  // the app DB context. Drain/periodic triggers are wired in main.ts.
  // Lazy require with no static type reference: electron/sync/* imports the
  // repo-root shared engine, outside this tsconfig's rootDir. A `typeof import`
  // would still pull it into the program, so we keep it fully dynamic; esbuild
  // resolves the require at build time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const syncHandlers = require("../sync/sync-handlers");
  syncHandlers.registerSyncHandlers(
    {
      db: ctx.db,
      getWin: ctx.getWin,
      // Apply a conflict resolution to the DB row AND its .md file, mirroring the
      // db:note:update / db:note:delete handlers (echo-suppressed so the file
      // watcher doesn't re-import our own write).
      conflictDeps: {
        updateNoteBody: (id: string, title: string, content: string) => {
          suppressNextChange(id);
          const note = q.updateNote(ctx.db, id, { title, content, contentText: content });
          if (note && note.type !== "dashboard") {
            writeNoteFile(ctx.workspacePath, { ...note, projectName: getProjectName(ctx.db, note.projectId) });
          }
        },
        deleteNoteRow: (id: string) => {
          const note = q.getNoteById(ctx.db, id);
          suppressNextChange(id);
          q.deleteNote(ctx.db, id);
          if (note && note.type !== "dashboard") {
            deleteNoteFile(ctx.workspacePath, getProjectName(ctx.db, note.projectId), id);
          }
        },
      },
      broadcastDbChanged: () => broadcastEvent("db:changed", null),
    },
    registerIpcHandle,
    handle,
  );
}
