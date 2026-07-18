/**
 * Cairn — Boot sequence orchestrator
 *
 * Runs the pre-app startup steps sequentially, reporting progress to the
 * splash window. Each step is wrapped in try/catch so a failure in one step
 * doesn't block the others — the app still boots even if reindex fails.
 *
 * Steps:
 *   1. Update check (prod only) — autoUpdater.checkForUpdates()
 *   2. Workspace migrations — checkMigrations + runAllPendingMigrations
 *   3. Embeddings reindex — if model changed, reindexNotes
 *   4. Notes sync — syncNotesFromDisk
 *
 * After all steps complete (or error), the caller destroys the splash
 * and creates the main window.
 */
import { autoUpdater } from "electron-updater";
import type Database from "better-sqlite3";

import { BootSplash } from "./bootsplash";
import { checkMigrations, runAllPendingMigrations } from "../migrations";
import { reindexNotes } from "../embeddings/service";
import { getEmbeddingsSettingsCached } from "../lib/config-cache";
import { resolveEmbeddingModelId, getDefaultModelId } from "../embeddings/client";
import * as manifest from "../embeddings/manifest";
import { syncNotesFromDisk, deleteNoteFile, reconcileProjectFolders } from "../notes-files";
import { computeSemanticRelationships } from "../db/graph-queries";
import { findTombstonedNotes } from "../db/queries";
import { getProjectName } from "../ipc/result-helpers";
import { saveCachedConfig } from "../lib/config-cache";
import * as runtime from "../runtime/client";

export interface BootContext {
  db: Database.Database;
  workspacePath: string;
  workspaceId: string;
  isDev: boolean;
}

export interface BootResult {
  updateInstalled: boolean;
  migrationsRan: number;
  reindexed: boolean;
  notesSynced: number;
  errors: string[];
}

export async function runBootSequence(
  splash: BootSplash,
  ctx: BootContext,
): Promise<BootResult> {
  const errors: string[] = [];
  let updateInstalled = false;
  let migrationsRan = 0;
  let reindexed = false;
  let notesSynced = 0;

  // Emit a real progress event immediately so the splash doesn't sit at
  // "Registering handlers…" (sent by main.ts) until the first step fires.
  splash.progress({ step: "migrations", label: "Preparing workspace…", pct: 8 });

  // ── Step 1: Update check (prod only) ──────────────────────────────────
  // Block the boot until the update is downloaded and installed. This
  // ensures the main window never opens with a known-broken build — the
  // update heals the app before any potentially crashing renderer code
  // runs. To avoid the splash appearing frozen during the ~172 MB
  // download, we pipe live download-progress events to the splash UI.
  if (!ctx.isDev) {
    try {
      splash.progress({ step: "update", label: "Checking for updates…", pct: 10 });
      const result = await autoUpdater.checkForUpdates();
      // electron-updater always returns `updateInfo` (truthy) even when no
      // update is available — only proceed when `isUpdateAvailable` is true.
      // Without this check, running the same version locally as the published
      // release would stall on "Downloading update v2.1.6…" for 300s.
      if (result && result.isUpdateAvailable && result.updateInfo) {
        const version = result.updateInfo.version;
        splash.progress({
          step: "update",
          label: `Downloading update v${version}…`,
          detail: "Starting download",
          pct: 15,
        });

        // Pipe live download progress to the splash so the user sees a
        // moving progress bar instead of a frozen "Downloading…" label.
        const progressHandler = (p: { percent: number; transferred: number; total: number; bytesPerSecond: number }) => {
          const pct = Math.round(p.percent);
          const transferredMB = (p.transferred / 1024 / 1024).toFixed(1);
          const totalMB = (p.total / 1024 / 1024).toFixed(1);
          const speedMB = (p.bytesPerSecond / 1024 / 1024).toFixed(1);
          splash.progress({
            step: "update",
            label: `Downloading update v${version}…`,
            detail: `${transferredMB} / ${totalMB} MB (${speedMB} MB/s)`,
            pct: 15 + Math.floor(pct * 0.80), // map 0-100% download to 15-95% boot
          });
        };
        autoUpdater.on("download-progress", progressHandler);

        let cleanupDownloaded: (() => void) | undefined;
        let cleanupError: (() => void) | undefined;

        try {
          // Wait for the download to complete. electron-updater emits
          // 'update-downloaded' when ready. autoDownload is true (set in
          // main.ts), so the download starts automatically after
          // checkForUpdates resolves.
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error("update download timed out after 300s"));
            }, 300_000);

            const onDownloaded = () => {
              clearTimeout(timeout);
              splash.progress({
                step: "update",
                label: `Installing v${version}…`,
                detail: "The app will restart automatically",
                pct: 100,
              });
              updateInstalled = true;
              // quitAndInstall restarts the app — the boot sequence will
              // run again on next launch (finding no update).
              autoUpdater.quitAndInstall();
              // The app quits here, so resolve is technically unreachable.
              resolve();
            };

            const onError = (err: Error) => {
              clearTimeout(timeout);
              reject(err);
            };

            autoUpdater.once("update-downloaded", onDownloaded);
            autoUpdater.once("error", onError);
            // Store refs so the finally block can deregister them if the
            // timeout fires before the download completes — otherwise
            // quitAndInstall() could fire unexpectedly later.
            cleanupDownloaded = () => autoUpdater.off("update-downloaded", onDownloaded);
            cleanupError = () => autoUpdater.off("error", onError);
          });
        } finally {
          autoUpdater.off("download-progress", progressHandler);
          cleanupDownloaded?.();
          cleanupError?.();
        }
      }
    } catch (err) {
      // Network error, update server down, download timeout, etc. —
      // don't block the boot entirely. Better to try launching the app
      // (which may work fine) than to leave the user stuck on splash.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[boot] Update check failed:", msg);
      errors.push(`Update check: ${msg}`);
    }
    splash.stepDone("Update check");
  }

  // ── Step 2: Workspace migrations ──────────────────────────────────────
  try {
    splash.progress({ step: "migrations", label: "Checking migrations…", pct: 0 });
    const pending = checkMigrations(ctx.workspacePath).filter((m) => m.needed);

    if (pending.length > 0) {
      splash.progress({
        step: "migrations",
        label: `Running ${pending.length} migration${pending.length > 1 ? "s" : ""}…`,
        pct: 0,
      });

      migrationsRan = await runAllPendingMigrations(
        ctx.workspacePath,
        (migrationId, pct, msg) => {
          splash.progress({
            step: "migrations",
            label: `Migrating: ${migrationId}`,
            detail: msg,
            pct,
          });
        },
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[boot] Migration failed:", msg);
    errors.push(`Migration: ${msg}`);
  }
  splash.stepDone("Migrations");

  // ── Step 3: Embeddings reindex ────────────────────────────────────────
  try {
    splash.progress({ step: "reindex", label: "Checking embeddings…", pct: 0 });
    const settings = getEmbeddingsSettingsCached();

    if (settings.enabled) {
      // Start the unified runtime process so embeddings are immediately
      // available for search and semantic features. Without this, the runtime
      // only starts lazily when an embed call happens — which means the first
      // search after app launch fails until the user toggles embeddings off/on.
      splash.progress({
        step: "reindex",
        label: "Starting embeddings engine…",
        pct: 0,
      });

      // Resolve model id with self-heal (same logic as the IPC handler).
      const model = resolveEmbeddingModelId(
        settings.modelId,
        getDefaultModelId(),
      );
      if (settings.modelId !== model) {
        console.log(
          `[boot] self-healing stale modelId: ${settings.modelId ?? "(none)"} → ${model}`,
        );
        saveCachedConfig("embeddings", { modelId: model });
        manifest.writeDefaultModelId(model);
      }

      try {
        await runtime.ensureStarted();

        // Verify the embedding model is actually installed. If not,
        // download it now so search and semantic features work immediately.
        const models = await runtime.listEmbeddingModels();
        const modelEntry = models.find((m) => m.id === model);
        if (modelEntry && modelEntry.status !== "installed") {
          splash.progress({
            step: "reindex",
            label: `Downloading embedding model…`,
            detail: modelEntry.name,
            pct: 0,
          });

          // Subscribe to download progress
          const off = runtime.onProgress((ev) => {
            if (ev.kind === "progress" && ev.modelId === model) {
              const pct = ev.total && ev.total > 0 && ev.loaded
                ? Math.round((ev.loaded / ev.total) * 100)
                : ev.progress ?? 0;
              const loadedMB = ev.loaded ? (ev.loaded / 1024 / 1024).toFixed(1) : "";
              const totalMB = ev.total ? (ev.total / 1024 / 1024).toFixed(1) : "";
              splash.progress({
                step: "reindex",
                label: "Downloading embedding model…",
                detail: totalMB ? `${loadedMB} / ${totalMB} MB` : `${pct}%`,
                pct,
              });
            }
          });

          try {
            await runtime.installEmbeddingModel(model);
          } finally {
            off();
          }
        }
      } catch (err) {
        console.warn("[boot] Runtime startup / model install failed:", err instanceof Error ? err.message : err);
        errors.push(`Runtime startup: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Check for any embedding rows with a mismatched model.
      const row = ctx.db.prepare(
        "SELECT 1 FROM note_embeddings WHERE model != ? LIMIT 1",
      ).get(model) as { 1?: number } | undefined;

      if (row) {
        splash.progress({
          step: "reindex",
          label: "Re-indexing notes with new model…",
          detail: "This may take a moment",
          pct: 0,
        });

        const result = await reindexNotes(
          ctx.db,
          ctx.workspaceId,
          undefined,
          model,
          undefined,
          (done, total) => {
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            splash.progress({
              step: "reindex",
              label: "Re-indexing notes…",
              detail: `${done} / ${total} notes`,
              pct,
            });
          },
        );
        reindexed = result.indexed > 0;

        if (result.total > 0) {
          try {
            computeSemanticRelationships(ctx.db, ctx.workspaceId, undefined);
          } catch (e) {
            console.warn("[boot] semantic recompute failed:", e instanceof Error ? e.message : e);
          }
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[boot] Embeddings reindex failed:", msg);
    errors.push(`Reindex: ${msg}`);
  }
  splash.stepDone("Embeddings");

  // ── Step 4: Notes sync ─────────────────────────────────────────────────
  try {
    splash.progress({
      step: "notes-sync",
      label: "Syncing notes…",
      pct: 0,
    });

    // Relocate any project note folders left under an old name by a rename that
    // happened before folder-relocation shipped (e.g. "Test Project" → "Misc"
    // but the .md files still sit in <ws>/Test Project/). Must run BEFORE the
    // disk scan so notes are imported from their correct, current location.
    try {
      const relocated = reconcileProjectFolders(ctx.db, ctx.workspacePath);
      if (relocated > 0) {
        console.log(`[boot] Relocated ${relocated} stale project folder(s).`);
      }
    } catch (err) {
      console.error("[boot] Project-folder reconcile failed:", err);
    }

    // Remove the orphaned `.md` files of notes that are TOMBSTONED (deleted on a
    // peer). We KEEP the tombstone rows themselves (getNotes filters
    // deleted_at IS NULL, so they don't show) — physically deleting them made
    // every subsequent peer delete op re-apply and re-stage (the "sent=31 never
    // settles" loop). But their .md files must go so the disk scan below can't
    // re-adopt them as new notes. Best-effort per note.
    try {
      const tombstoned = findTombstonedNotes(ctx.db);
      for (const n of tombstoned) {
        if (n.type === "dashboard") continue; // no .md file
        try {
          deleteNoteFile(ctx.workspacePath, getProjectName(ctx.db, n.projectId), n.id);
        } catch { /* file may already be gone */ }
      }
      if (tombstoned.length > 0) {
        console.log(`[boot] Cleaned up ${tombstoned.length} tombstoned note file(s).`);
      }
    } catch (err) {
      console.error("[boot] Tombstone file cleanup failed:", err);
    }

    // NOTE: nested conflict-copy junk (`…_conflict_…_conflict_…`) is cleaned up
    // separately in main.ts AFTER the sync engine is wired, because those rows
    // must be tombstoned THROUGH the engine (so the delete propagates to the
    // peer and both devices converge) — a physical delete here would just be
    // re-created from the peer's oplog on the next sync.

    // syncNotesFromDisk is synchronous but potentially slow for large
    // workspaces. We run it in a microtask to let the splash paint.
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        syncNotesFromDisk(ctx.db, ctx.workspacePath);
        resolve();
      });
    });

    splash.progress({
      step: "notes-sync",
      label: "Syncing notes…",
      pct: 100,
    });
    notesSynced = 1; // syncNotesFromDisk doesn't return a count
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[boot] Notes sync failed:", msg);
    errors.push(`Notes sync: ${msg}`);
  }
  splash.stepDone("Notes sync");

  // ── Done ──────────────────────────────────────────────────────────────
  // The final "Ready" / 100% progress event is sent by main.ts in
  // closeSplash() — after the main window has finished loading.

  return { updateInstalled, migrationsRan, reindexed, notesSynced, errors };
}
