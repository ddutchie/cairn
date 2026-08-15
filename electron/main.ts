/**
 * Cairn — Electron main process
 *
 * Orchestrates startup:
 * 1. Register the app:// protocol + CSP
 * 2. Resolve workspace folder
 * 3. Initialise SQLite
 * 4. Register IPC handlers
 * 5. Create BrowserWindow
 * 6. Set up auto-updater (prod only)
 * 7. Start file watcher for external .md edits
 * 8. Create system tray
 * 9. Start MCP notification poller
 */

import { app, BrowserWindow, shell, protocol } from "electron";
import path from "path";
import fs from "fs";
import { autoUpdater } from "electron-updater";
import { loadMobileSettings, startMobileServer, stopMobileServer } from "./lib/mobile-server";
import { initDb } from "./db/client";
import { registerIpcHandlers, registerAppHandlers } from "./ipc/handlers";
import { broadcastEvent } from "./ipc/registry";
import { registerAgentHandlers } from "./ipc/agent";
import { registerToolsHandlers } from "./ipc/tools";
import { registerToolBuilderHandlers } from "./ipc/tool-builder";
import { registerCommunityRegistryHandlers } from "./ipc/community-registry-handlers";
import { registerGitHandlers } from "./ipc/git";
import { registerPiAgentHandler } from "./ipc/pi-agent";
import { readWorkspaceConfig, getDbPathForWorkspace } from "./workspace-config";
import { startFileWatcher, suppressNextChange } from "./file-watcher";
import { syncNotesFromDisk, writeNoteFile, deleteNoteFile, setPathRemover } from "./notes-files";
import { markMcpNotificationsRead, getNoteByIdIncludingTombstoned, findNestedConflictCopies } from "./db/queries";
import { recoverInterruptedRuns } from "./db/automation-queries";
import { getProjectName } from "./ipc/result-helpers";
import { setupProtocol, registerAssetProtocol, setAssetWorkspacePath } from "./lib/protocol";
import { createTray } from "./lib/tray";
import { killTrackedBashProcesses } from "./lib/coding-tools/bash";
import { startMcpNotificationPoller } from "./lib/mcp-poller";
import { HeartbeatScheduler } from "./lib/heartbeat-scheduler";
import { runAutomation } from "./lib/heartbeat-runner";
import { stopServerSync } from "./lib/llama-server";
import { dispose as disposeEmbeddingsWorker } from "./embeddings/client";
import * as runtime from "./runtime/client";
import { BootSplash } from "./splash/bootsplash";
import { runBootSequence } from "./splash/boot-sequence";
import { registerChatPopoutHandlers } from "./chat-popout";
import { DEEP_LINK_SCHEME, parseOAuthCallback, completeServerAuth } from "./lib/mcp-oauth";

const isDev = !app.isPackaged;

// ── Deep-link (cairn://) registration + OAuth callback routing ───────────────
// Used by the remote-MCP OAuth flow: the authorization server redirects to
// cairn://oauth/callback?code=…&state=…, which the OS hands back to us as either
// an open-url event (macOS) or a process argv entry (Windows/Linux).
if (isDev && process.platform === "win32" && process.argv.length >= 2) {
  // In dev on Windows the executable is electron.exe with our entry script as
  // argv[1]; the launcher must be registered with that path so the OS can
  // re-invoke us for a deep link.
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
}

/** Find the first cairn:// deep link in a process argv array, if any. */
function deepLinkFromArgv(argv: string[]): string | null {
  return argv.find((a) => typeof a === "string" && a.startsWith(`${DEEP_LINK_SCHEME}://`)) ?? null;
}

/** Buffer for a deep link that arrives before the renderer is ready. */
let _pendingDeepLink: string | null = null;
/** True once the main window's renderer has finished loading (listeners attached). */
let _rendererReady = false;

/** Route a cairn:// deep link. Currently only OAuth callbacks are handled. */
async function handleDeepLink(rawUrl: string): Promise<void> {
  const cb = parseOAuthCallback(rawUrl);
  if (!cb) return;
  const win = BrowserWindow.getAllWindows()[0] ?? null;
  // If the renderer isn't ready to receive the result event yet, buffer the raw
  // link and let the post-load flush replay it through this same path.
  if (!win || !_rendererReady) {
    _pendingDeepLink = rawUrl;
    return;
  }
  if (win.isMinimized()) win.restore();
  win.focus();
  const result = await completeServerAuth(cb);
  // Tell the renderer how it went so Settings can refresh the connection state.
  win.webContents.send("tools:oauthCallback", result);
}

/** Flush any buffered deep link once the renderer is ready. */
function flushPendingDeepLink(): void {
  const link = _pendingDeepLink ?? deepLinkFromArgv(process.argv);
  _pendingDeepLink = null;
  if (link) void handleDeepLink(link);
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    // Focus the existing window, and pick up a deep link passed on the relaunch
    // argv (Windows/Linux delivery path for cairn://…).
    const allWindows = BrowserWindow.getAllWindows();
    if (allWindows.length > 0) {
      if (allWindows[0].isMinimized()) allWindows[0].restore();
      allWindows[0].focus();
    }
    const link = deepLinkFromArgv(argv);
    if (link) void handleDeepLink(link);
  });
}

// macOS delivers deep links via open-url (can fire before whenReady on cold
// start; handleDeepLink buffers until the renderer is ready).
app.on("open-url", (event, url) => {
  event.preventDefault();
  void handleDeepLink(url);
});

app.setName("Cairn");

// Windows: required for Toast notifications to show with the correct app identity.
// Must be called before app.whenReady() and must match the appId in electron-builder.yml.
if (process.platform === "win32") {
  app.setAppUserModelId("com.cairn.app");
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
  {
    scheme: "asset",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
]);

// Returns the window background colour for the stored theme.
// Used as BrowserWindow.backgroundColor (fills the window before React renders).
function getStoredThemeBackground(): string {
  try {
    const userDataPath = app.getPath("userData");
    const themeFile = path.join(userDataPath, "theme.json");
    if (fs.existsSync(themeFile)) {
      const t = JSON.parse(fs.readFileSync(themeFile, "utf8")).theme;
      if (t === "light") return "#f5f4f1";
    }
  } catch { /* ignore */ }
  return "#0d0d0d";
}

// Returns the --surface colour for the stored theme.
// Used as the titleBarOverlay colour on Windows so the native min/max/close
// buttons blend with the rendered TitleBar component (bg-[var(--surface)]).
// Must match the --surface values in globals.css exactly.
function getStoredThemeSurface(): string {
  try {
    const userDataPath = app.getPath("userData");
    const themeFile = path.join(userDataPath, "theme.json");
    if (fs.existsSync(themeFile)) {
      const t = JSON.parse(fs.readFileSync(themeFile, "utf8")).theme;
      if (t === "light") return "#ffffff";  // --surface in .light (globals.css:35)
    }
  } catch { /* ignore */ }
  return "#141414";  // --surface in .dark (globals.css:11)
}

function createWindow(): BrowserWindow {
  const isWin = process.platform === "win32";
  const bg = getStoredThemeBackground();
  const surface = getStoredThemeSurface();

  // On macOS: hiddenInset keeps the traffic lights in the title bar area.
  // On Windows: hidden removes the native title text; titleBarOverlay places
  // the native min/max/close buttons at the top-right inside our custom bar.
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: isWin ? "hidden" : "hiddenInset",
    ...(isWin && {
      titleBarOverlay: {
        // Use --surface (not backgroundColor) so the overlay matches the
        // rendered TitleBar component which uses bg-[var(--surface)].
        color: surface,
        symbolColor: "#888888",
        // 39px not 40px: Windows adds a 1px window border at the top, so
        // height:40 overshoots by 1px and clips the border-b beneath the bar.
        height: 39,
      },
    }),
    backgroundColor: bg,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    win.loadURL("http://localhost:3000");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadURL("app://./index.html");
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

app.whenReady().then(async () => {
  const outDir = path.join(__dirname, "../out");
  setupProtocol(outDir);

  // Route deleted note files/folders to the OS trash (Finder/Explorer) so a
  // user can restore them, instead of a permanent fs delete. shell.trashItem is
  // async + main-process-only; we fire-and-forget (the DB row is already gone)
  // and fall back to a hard delete if trashing fails (e.g. no desktop trash).
  setPathRemover((targetPath) => {
    shell.trashItem(targetPath).catch(() => {
      try { fs.rmSync(targetPath, { recursive: true, force: true }); } catch { /* ignore */ }
    });
  });

  const userDataPath = app.getPath("userData");

  // ── Resolve workspace path ────────────────────────────────────────────
  const config = readWorkspaceConfig(userDataPath);
  const initialWorkspacePath = config
    ? config.workspacePath
    : path.join(userDataPath, "cairn"); // fallback while onboarding

  if (config) fs.mkdirSync(initialWorkspacePath, { recursive: true });

  // Register the asset:// protocol handler once. The workspace path it reads
  // is updated via setAssetWorkspacePath() — no re-registration needed.
  registerAssetProtocol();
  setAssetWorkspacePath(initialWorkspacePath);

  const initialDbPath = getDbPathForWorkspace(initialWorkspacePath);
  const initialDb = initDb(initialDbPath);

  // ── Mutable context — swapped in reinitialise() without relaunching ──
  // getWin is a lazy getter so it works even though win is assigned after ctx.
  let _win: import("electron").BrowserWindow | null = null;
  const ctx: import("./ipc/handlers").DbContext = {
    db: initialDb,
    workspacePath: initialWorkspacePath,
    getWin: () => _win,
  };

  // Register IPC handlers before boot sequence (boot calls reindexNotes,
  // runAllPendingMigrations, etc. which need handler-level model resolution).
  registerIpcHandlers(ctx);
  registerAgentHandlers(ctx.db);
  registerToolsHandlers(ctx.db);
  registerToolBuilderHandlers(ctx.db, ctx.getWin);
  registerCommunityRegistryHandlers();
  registerGitHandlers(ctx.db);
  registerPiAgentHandler(ctx);
  registerChatPopoutHandlers();

  // ── Splash + boot sequence ────────────────────────────────────────────
  // Create the splash window immediately so the user sees something while
  // update check, migrations, reindex, and notes sync run. The main window
  // is only created after the boot sequence completes (or errors).
  const splash = new BootSplash();
  splash.create();

  // Emit real progress for the pre-boot work that happens between splash
  // creation and runBootSequence. Without these events the splash sits at
  // 0% with "Starting…" until the first boot step fires. We intentionally
  // omit pct — boot-sequence.ts owns the full 0-100% range and sending a
  //数值 here would cause a backwards jump when migrations starts at 0%.
  splash.progress({ step: "migrations", label: "Opening database…" });

  // Resolve workspace ID from DB (may not exist on first launch / onboarding).
  const wsRow = initialDb.prepare(
    "SELECT id FROM workspaces ORDER BY created_at LIMIT 1",
  ).get() as { id?: string } | undefined;
  const workspaceId = wsRow?.id ?? "";

  splash.progress({ step: "migrations", label: "Registering handlers…" });

  let bootErrors: string[] = [];
  try {
    const result = await runBootSequence(splash, {
      db: initialDb,
      workspacePath: initialWorkspacePath,
      workspaceId,
      isDev,
    });
    bootErrors = result.errors;
  } catch (err) {
    bootErrors.push(err instanceof Error ? err.message : String(err));
  }

  // ── Create main window ─────────────────────────────────────────────────
  const win = createWindow();
  _win = win;

  // Close splash after the main window has finished loading its first page.
  // The main window is created hidden (show: false) so only the splash is
  // visible during boot. Once the renderer has painted, we send the final
  // "Ready" progress, wait 200ms for the CSS transition to animate, then
  // show the main window and close the splash.
  const closeSplash = () => {
    splash.progress({ step: "done", label: "Ready", pct: 100 });
    setTimeout(() => {
      win.show();
      splash.close();
    }, 200);
  };
  win.webContents.once("did-finish-load", () => {
    closeSplash();
    // Renderer is now loaded and its IPC listeners (incl. onOauthCallback) are
    // attached — safe to deliver any deep link that arrived during boot
    // (macOS open-url cold start, or a cairn:// URL in our own launch argv on
    // Windows/Linux).
    _rendererReady = true;
    flushPendingDeepLink();
  });
  setTimeout(() => {
    closeSplash();
  }, 6000);

  // ── File watcher for external .md edits ──────────────────────────────
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function notifyDbChanged() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.send("db:changed");
    }, 300);
  }

  startFileWatcher(initialWorkspacePath, initialDb, notifyDbChanged);

  // ── Reinitialise without relaunching ─────────────────────────────────
  // Called by app:initWorkspace when the user picks a workspace folder for
  // the first time. Swaps the DB and file watcher in place so the onboarding
  // wizard can continue without a full app restart.
  async function reinitialise(newWorkspacePath: string): Promise<void> {
    fs.mkdirSync(newWorkspacePath, { recursive: true });

    // Open the new DB
    const newDbPath = getDbPathForWorkspace(newWorkspacePath);
    const newDb = initDb(newDbPath);

    // Recover any notes on disk not yet in SQLite before swapping context
    syncNotesFromDisk(newDb, newWorkspacePath);

    // Swap context — all handlers read from ctx at call time
    ctx.db = newDb;
    ctx.workspacePath = newWorkspacePath;

    // Re-arm DB hygiene (auto-vacuum + periodic reclaim) for the new DB.
    const { runStartupHygiene } = await import("./lib/db-hygiene");
    runStartupHygiene(newDb);

    // Recover runs left in-flight by a previous process on this workspace.
    try { recoverInterruptedRuns(newDb); } catch { /* non-critical */ }

    // Restart file watcher on the new path
    startFileWatcher(newWorkspacePath, newDb, notifyDbChanged);

    // Point the asset:// handler at the new workspace (no re-registration needed)
    setAssetWorkspacePath(newWorkspacePath);

    // Tell the renderer to re-hydrate from the new DB
    if (!win.isDestroyed()) {
      win.webContents.send("db:changed");
    }
  }

  // ── Auto-updater (prod only) ──────────────────────────────────────────
  // The initial update check runs in the boot sequence (above). Here we only
  // register the event handlers for the in-app notification UI and set up the
  // 4-hour poller for updates released during the session.
  if (!isDev) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", (info) => {
      if (!win.isDestroyed()) win.webContents.send("updater:update-available", {
        version: info.version,
        releaseNotes: info.releaseNotes ?? null,
      });
    });

    autoUpdater.on("update-downloaded", () => {
      if (!win.isDestroyed()) win.webContents.send("updater:update-downloaded");
    });

    autoUpdater.on("error", (err) => {
      console.error("[updater]", err.message);
    });

    // Poll for updates every 4 hours (initial check was done in boot sequence).
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
  }

  // ── System tray ───────────────────────────────────────────────────────
  const { updateBadge } = createTray(win);

  // ── MCP notification poller ───────────────────────────────────────────
  const poller = startMcpNotificationPoller({
    db: ctx.db,
    dbPath: initialDbPath,
    win,
    updateBadge,
    onDbChanged: notifyDbChanged,
  });

  // ── Heartbeat scheduler (scheduled / recurring background automations) ──
  // Drives the `automations` table while the app is open. The runner is the
  // headless data-only knowledge agent (no bash / file-edit), so a background
  // run's blast radius stays bounded to Cairn entities. ctx.db is re-read on
  // every tick so a workspace reinitialise is transparent. Stopped on quit so
  // no background turns fire during teardown.
  //
  // Recover runs left in-flight by a previous process (crash / quit mid-turn /
  // dev reload): a stuck 'running' row would otherwise block the automation
  // forever via the scheduler's skip-on-overlap guard.
  try {
    const recovered = recoverInterruptedRuns(ctx.db);
    if (recovered > 0) console.log(`[heartbeat] recovered ${recovered} interrupted automation run(s)`);
  } catch (err) {
    console.warn("[heartbeat] failed to recover interrupted runs:", err);
  }
  const heartbeatScheduler = new HeartbeatScheduler({
    dbGetter: () => ctx.db,
    runner: (run, automation) => runAutomation(
      {
        db: ctx.db,
        workspacePath: ctx.workspacePath,
        send: (channel, payload) => broadcastEvent(channel, payload),
      },
      run,
      automation,
    ),
    log: (msg) => console.log(msg),
  });
  heartbeatScheduler.start();

  // Shared reset — marks all notifications read + zeroes the badge. Called from
  // the renderer's "mark all read" (via the IPC handler's onBadgeClear). Unlike
  // before, window focus does NOT auto-clear — unread persists until the user
  // dismisses it in the notification center, so the sidebar bell stays accurate.
  function clearBadge() {
    markMcpNotificationsRead(ctx.db);
    updateBadge(0);
    poller.resetCount();
    if (!win.isDestroyed()) win.webContents.send("mcp:unread-count", 0);
  }

  // Register app:* and mcp:* IPC handlers (now that updateBadge is available)
  registerAppHandlers(ctx, userDataPath, updateBadge, reinitialise, clearBadge);

  // ── Desktop sync drain/sync wiring ───────────────────────────────────────
  // The sync engine + folder connect live in electron/sync. Here we drive it:
  //  - drain staged writes frequently (cheap; coalesces bursts),
  //  - periodically full-sync as the primary + safety-net path,
  //  - drain + sync on resume-from-sleep / window focus / before quit,
  // so nothing sits un-synced (JS timers pause during sleep — see the P1 note).
  // Writes from every path (renderer IPC, MCP, file-watcher) land in
  // sync_pending via the capture triggers, so a periodic drain catches them all
  // regardless of source — no per-write hook needed.
  // desktop-sync lives under electron/sync/** which is EXCLUDED from the
  // electron tsconfig (it's type-checked via tsconfig.shared.json to import the
  // repo-root shared engine). So it must be require()'d here, not statically
  // imported — the one remaining runtime require in this file.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const desktopSync = require("./sync/desktop-sync");
  const drainDesktop: (db: unknown) => number = desktopSync.drainDesktop;
  const syncDesktop: (db: unknown, projectNote?: (noteId: string, op: "put" | "delete") => void) => Promise<{ seeded: number; drained: number; peerOpsApplied: number; peerOpsRead: number; conflictCopies: number; connected: boolean }> = desktopSync.syncDesktop;
  const getSyncFolder: (db: unknown) => string | null = desktopSync.getSyncFolder;
  const setSyncStatusListener: (fn: ((s: unknown) => void) | null) => void = desktopSync.setSyncStatusListener;
  const refreshSyncStatus: (db: unknown) => void = desktopSync.refreshSyncStatus;

  // Push every sync-status transition (idle/syncing/offline + pending/conflict
  // counts) to the renderer so the title-bar indicator stays live.
  setSyncStatusListener((status: unknown) => {
    if (!win.isDestroyed()) win.webContents.send("sync:status", status);
  });

  // Project an inbound (synced) note change onto disk so the .md file stays in
  // lock-step with cairn.db — the desktop's normal dual-write, applied to edits
  // that arrive from the phone. Echo-suppressed so the file-watcher doesn't
  // re-import our own write as an external edit and loop it back into the DB.
  function projectNoteToDisk(noteId: string, op: "put" | "delete") {
    // Read INCLUDING tombstones: on an inbound `delete` the row is soft-deleted
    // (deleted_at set), and getNoteById() now filters those out — using it here
    // would return null and skip removing the orphaned .md file. We still want
    // the live row's data for a `put`.
    const note = getNoteByIdIncludingTombstoned(ctx.db, noteId);
    if (!note || note.type === "dashboard") return; // dashboards have no .md
    suppressNextChange(noteId);
    const projectName = getProjectName(ctx.db, note.projectId);
    if (op === "delete" || note.deletedAt || note.archivedAt) {
      deleteNoteFile(ctx.workspacePath, projectName, note.id);
    } else {
      writeNoteFile(ctx.workspacePath, { ...note, projectName });
    }
    // NOTE: on a synced delete we intentionally do NOT physically delete the DB
    // row. The engine keeps it tombstoned (deleted_at set); getNotes() and the
    // other live reads filter `deleted_at IS NULL`, so it disappears from the UI
    // just the same. Physically deleting it here was a mistake: it left the row
    // absent, so every subsequent peer `delete` op re-applied (insertTombstoneShell
    // re-creates a shell → applied=true) and this projector re-ran, and the
    // physical delete fired the capture trigger OUTSIDE the engine's suppression
    // window — re-staging the delete on every sync (the "sent=31 never settles"
    // loop). Keeping the tombstone lets the staleness guard stop the re-apply.
  }
  // Register once so both the periodic loop and the manual sync:now IPC handler
  // re-emit .md files for inbound note changes.
  desktopSync.setNoteFileProjector(projectNoteToDisk);

  // Clean up NESTED conflict-copy junk (`…_conflict_…_conflict_…`) left by the
  // old "conflict copy of a conflict copy" bug — an exploding pile that churned
  // as perpetual pending deletes ("N pending never settles"). Tombstoning MUST
  // go through the sync engine (fresh HLC) so the delete wins over the peer's
  // re-broadcast and BOTH devices converge; a raw physical delete would be
  // re-created from the peer's oplog. Best-effort; also drops their .md.
  //
  // Runs AFTER a sync has imported peer ops (not just at startup), because the
  // junk often lives only in the PEER's oplog and doesn't exist locally until
  // it's pulled in — a startup-only pass would miss it this session. Loops (with
  // a safety cap) so a batch that surfaces mid-session still converges. Returns
  // how many it tombstoned.
  function cleanupNestedConflictCopies(): number {
    let total = 0;
    try {
      if (!getSyncFolder(ctx.db)) return 0; // no peer to converge with
      // Each pass tombstones the current candidates (which then drop out of the
      // deleted_at-filtered finder); a handful of passes covers anything that
      // becomes visible as prior tombstones settle. Cap guards against a bug.
      for (let pass = 0; pass < 5; pass++) {
        const nested = findNestedConflictCopies(ctx.db);
        if (nested.length === 0) break;
        const n = desktopSync.tombstoneNotesViaSync(ctx.db, nested.map((r: { id: string }) => r.id));
        for (const r of nested) {
          if (r.type === "dashboard") continue;
          try {
            deleteNoteFile(ctx.workspacePath, getProjectName(ctx.db, r.projectId), r.id);
          } catch { /* file may already be gone */ }
        }
        total += n;
      }
      if (total > 0) {
        console.log(`[sync] Tombstoned ${total} nested conflict-copy note(s) (junk cleanup).`);
      }
    } catch (err) {
      console.error("[sync] Nested conflict-copy cleanup failed:", err);
    }
    return total;
  }

  async function runFullSync(reason: string) {
    try {
      if (!getSyncFolder(ctx.db)) {
        // Device Sync not enabled: do nothing. We deliberately DON'T drain here —
        // building the oplog while disconnected is wasted work and grows
        // sync_oplog for users who never sync. sync_pending simply accumulates
        // (cheap: entity/id/op rows) and is superseded by backfill() on first
        // connect, which seeds the whole workspace from current table state.
        return;
      }
      const r = await syncDesktop(ctx.db);
      // After peer ops are imported, sweep any nested conflict-copy junk that
      // arrived from the peer (it only exists locally once pulled in). If it
      // tombstoned anything, publish those deletes so the peer converges too.
      const cleaned = r.peerOpsApplied > 0 ? cleanupNestedConflictCopies() : 0;
      if (cleaned > 0) await syncDesktop(ctx.db);
      // Only log when something real happened (seeded / sent / actually applied).
      // A converged sync that merely READS the peer snapshot (peerOpsRead > 0 but
      // peerOpsApplied === 0) is silent — that steady read is normal, not a loop.
      if (r.seeded || r.drained || r.peerOpsApplied) {
        console.log(`[sync] ${reason}: seeded=${r.seeded} sent=${r.drained} applied=${r.peerOpsApplied} (read=${r.peerOpsRead}) conflicts=${r.conflictCopies}`);
        // If peers changed our data, tell the renderer to re-hydrate.
        if (r.peerOpsApplied > 0 && !win.isDestroyed()) win.webContents.send("db:changed");
      }
    } catch (err) {
      console.error(`[sync] ${reason} failed:`, err);
    }
  }

  // Wire the background-sync lifecycle (timers + power/focus/quit listeners) in
  // one place so the bookkeeping is isolated from the surrounding window setup.
  async function wireBackgroundSync(): Promise<void> {
    // Frequent cheap drain (turns staged writes into oplog ops) — only while a
    // sync folder is connected. When disabled, skip it so the oplog isn't built.
    const drainInterval = setInterval(() => {
      try {
        if (!getSyncFolder(ctx.db)) return;
        drainDesktop(ctx.db);
        // Reflect the current pending/conflict counts in the title-bar indicator.
        refreshSyncStatus(ctx.db);
      } catch (err) { console.error("[sync] drain:", err); }
    }, 5_000);
    // Full folder sync (publish + reconcile peers) as the primary + safety net.
    const syncInterval = setInterval(() => runFullSync("periodic"), 30_000);

    // Resume from sleep / focus / quit — timers may have been paused.
    const { powerMonitor } = await import("electron");
    powerMonitor.on("resume", () => runFullSync("resume"));
    win.on("focus", () => runFullSync("focus"));
    app.on("before-quit", () => {
      try {
        if (getSyncFolder(ctx.db)) { drainDesktop(ctx.db); runFullSync("before-quit"); }
      } catch { /* ignore */ }
      // Stop the heartbeat scheduler so no background automation fires during teardown.
      try { heartbeatScheduler.stop(); } catch { /* ignore */ }
      clearInterval(drainInterval);
      clearInterval(syncInterval);
    });

    // Initial sync shortly after boot (lets the workspace settle first).
    setTimeout(() => runFullSync("startup"), 3_000);
    // Publish the initial status immediately so the indicator reflects
    // connected/disabled + any existing conflict copies on launch.
    try { refreshSyncStatus(ctx.db); } catch { /* ignore */ }
  }
  await wireBackgroundSync();

  // Start mobile access server if enabled
  try {
    const mobileSettings = loadMobileSettings(userDataPath);
    if (mobileSettings.enabled) {
      startMobileServer(userDataPath, ctx);
    }
  } catch (err) {
    console.error("[main] Failed to auto-start mobile server:", err);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  // Terminate mobile access server if running
  try {
    stopMobileServer();
  } catch { /* ignore */ }

  // Kill any bash child processes that are still running so they don't linger
  killTrackedBashProcesses();
  // Terminate the local llama-server background child process so it doesn't linger
  stopServerSync();
  // Terminate the embeddings worker child process (HTTP server) so it doesn't linger
  void disposeEmbeddingsWorker();
  // Terminate the unified runtime process (embeddings + LLM proxy)
  runtime.stopRuntimeSync();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
