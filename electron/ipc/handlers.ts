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
import { registerUserStyleHandlers } from "./user-style-handlers";
import { registerUsageHandlers } from "./usage-handlers";
import { initUsageRecorder } from "../lib/usage-recorder";
import { runStartupHygiene } from "../lib/db-hygiene";

import { readWorkspaceConfig, writeWorkspaceConfig } from "../workspace-config";
import { markMcpNotificationsRead } from "../db/queries";
import * as q from "../db/queries";
import { writeNoteFile, deleteNoteFile, importVaultProjects, previewVaultImport, saveImportExclusions, syncNotesFromDisk, rollbackImport } from "../notes-files";
import { suppressNextChange } from "../file-watcher";
import { getProjectName } from "./result-helpers";
import { broadcastEvent } from "./registry";

/**
 * Register the DB + chat + flow + ai + llama + graph IPC handlers.
 * Called from main.ts once the DB context is established.
 */
export function registerIpcHandlers(ctx: DbContext): void {
  // Point the LLM usage recorder at the current DB (swapped on workspace change).
  initUsageRecorder(ctx.db);
  registerDbHandlers(ctx);
  registerChatHandler(ctx.db, ctx.workspacePath, ctx.getWin);
  registerChatDbHandlers(ctx);
  registerUserStyleHandlers(ctx);
  registerPiSessionHandlers(ctx);
  registerFlowHandlers(ctx);
  registerAiHandlers(ctx);
  registerLlamaHandlers(ctx);
  registerGraphHandlers(ctx);
  registerEmbeddingsHandlers(ctx);
  registerRuntimeHandlers(ctx);
  registerUsageHandlers(ctx);

  // DB file-size hygiene: switch to incremental auto-vacuum + reclaim bloat
  // (re-armed on every registration, including after a workspace re-init).
  runStartupHygiene(ctx.db);
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
      return result.filePaths[0];
    });
  });

  registerIpcHandle("app:getWorkspacePath", () => handle(() =>
    readWorkspaceConfig(userDataPath)?.workspacePath ?? null
  ));

  registerIpcHandle("app:needsWorkspaceSetup", () => handle(() =>
    readWorkspaceConfig(userDataPath) === null
  ));

  // Merge a partial update into theme.json without clobbering the other keys.
  // theme.json holds BOTH `theme` and `accent` so the boot splash can restore
  // them; writing one setting must preserve the other (see app:setTheme /
  // app:setAccent below).
  const mergeThemeFile = (patch: Record<string, unknown>) => {
    const themeFile = path.join(userDataPath, "theme.json");
    let existing: Record<string, unknown> = {};
    try {
      if (fs.existsSync(themeFile)) existing = JSON.parse(fs.readFileSync(themeFile, "utf8"));
    } catch {
      // ignore malformed file — overwrite below
    }
    fs.writeFileSync(themeFile, JSON.stringify({ ...existing, ...patch }), "utf8");
  };

  registerIpcHandle("app:setTheme", (_e, theme: string) => handle(() => {
    mergeThemeFile({ theme });
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

  registerIpcHandle("app:setAccent", (_e, accent: string) => handle(() => {
    // Persist the accent id alongside the theme so the next boot's splash can
    // render the right accent. Merge into the existing theme.json.
    mergeThemeFile({ accent });
  }));

  registerIpcHandle("app:initWorkspace", (_e, { workspacePath: newPath, excludedFolders }: { workspacePath: string; excludedFolders?: string[] }) => handle(async () => {
    // Complete the filesystem setup BEFORE persisting the workspace path: if
    // mkdir / exclusion config / re-init fails, the old workspace stays the
    // active one rather than committing a half-initialised path.
    fs.mkdirSync(newPath, { recursive: true });
    if (Array.isArray(excludedFolders)) saveImportExclusions(newPath, excludedFolders);
    if (onReinitialise) {
      await onReinitialise(newPath);
    }
    writeWorkspaceConfig(userDataPath, newPath);
    return { ok: true };
  }));

  // Re-scan the current workspace for on-disk projects and notes. Used by the
  // onboarding wizard AFTER the workspace record is created (the first scan in
  // reinitialise runs before createWorkspace, so it can't auto-create projects
  // yet — this catches the vault's folders once a workspace exists). Also useful
  // as a manual "refresh from disk" action. Returns the number of projects the
  // scan auto-created from folders.
  //
  // workspaceId identifies the workspace that owns ctx.workspacePath so
  // discovered projects attach to it — the caller (onboarding) knows the id of
  // the workspace it just created. When omitted, importVaultProjects falls back
  // to the oldest workspace.
  registerIpcHandle("app:rescanWorkspace", (_e, { workspaceId, excludedFolders }: { workspaceId?: string; excludedFolders?: string[] } = {}) => handle(() => {
    if (Array.isArray(excludedFolders)) saveImportExclusions(ctx.workspacePath, excludedFolders);
    // Snapshot the live project ids BEFORE the scan so we can report exactly
    // which projects the import newly created (for the onboarding summary).
    const beforeIds = new Set(
      (ctx.db.prepare("SELECT id FROM projects WHERE archived_at IS NULL").all() as { id: string }[])
        .map((r) => r.id),
    );
    // Run the discovery pass once and capture its count. syncNotesFromDisk below
    // also calls importVaultProjects, but by then every folder already maps to a
    // project so it short-circuits before any tree walk (idempotent no-op) — it
    // then imports the notes into those projects.
    const created = importVaultProjects(ctx.db, ctx.workspacePath, workspaceId);
    syncNotesFromDisk(ctx.db, ctx.workspacePath, workspaceId);

    // Report the newly-created projects with their imported note counts so the
    // onboarding wizard can show "we found these projects" instead of prompting
    // to create one.
    const createdProjects = (
      ctx.db.prepare("SELECT id, name FROM projects WHERE archived_at IS NULL ORDER BY created_at").all() as
        { id: string; name: string }[]
    )
      .filter((p) => !beforeIds.has(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        noteCount: (ctx.db.prepare(
          "SELECT COUNT(*) AS n FROM notes WHERE project_id = ? AND type = 'note' AND archived_at IS NULL AND deleted_at IS NULL",
        ).get(p.id) as { n: number }).n,
      }));

    const activeWin = ctx.getWin();
    if (activeWin && !activeWin.isDestroyed()) {
      activeWin.webContents.send("db:changed");
    }
    return { projectsCreated: created, createdProjects };
  }));

  // Undo an import: remove the projects it created (and their notes) WITHOUT
  // tombstoning them to sync peers, strip Cairn frontmatter from the adopted
  // files (preserving the user's own), and mark the vault un-managed so nothing
  // is re-adopted. Offered on the rescan result, immediately after import.
  registerIpcHandle("app:rollbackImport", (_e, { projectIds }: { projectIds?: string[] } = {}) => handle(() => {
    const removedNotes = rollbackImport(ctx.db, ctx.workspacePath, projectIds ?? []);
    const activeWin = ctx.getWin();
    if (activeWin && !activeWin.isDestroyed()) {
      activeWin.webContents.send("db:changed");
    }
    return { removedNotes, ok: true };
  }));

  // Read-only recursive preview of a folder before onboarding adopts it. No
  // frontmatter or config is written until rescanWorkspace is confirmed.
  registerIpcHandle("app:probeWorkspaceFolder", (_e, { folder }: { folder: string }) => handle(() => {
    // A blank/non-string folder must not reach previewVaultImport — its
    // path.join("", ".obsidian") would resolve against the process CWD and could
    // misreport an unrelated directory as a vault. Return a literal empty preview.
    if (!folder || typeof folder !== "string") {
      return { isObsidianVault: false, vaultName: "Notes", noteCount: 0, skippedCount: 0, projects: [], excludedFolders: [] };
    }
    return previewVaultImport(folder);
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
          const note = q.updateNote(ctx.db, id, { title, content });
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
