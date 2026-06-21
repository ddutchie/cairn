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
import { syncNotesFromDisk } from "../notes-files";
import { computeSemanticRelationships } from "../db/graph-queries";
import { saveCachedConfig } from "../lib/config-cache";

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

  // ── Step 1: Update check (prod only) ──────────────────────────────────
  if (!ctx.isDev) {
    try {
      splash.progress({ step: "update", label: "Checking for updates…", pct: 10 });
      const result = await autoUpdater.checkForUpdates();
      if (result && result.updateInfo) {
        const version = result.updateInfo.version;
        splash.progress({
          step: "update",
          label: `Downloading update v${version}…`,
          detail: "Auto-installing on download complete",
          pct: 30,
        });

        // Wait for the download to complete. electron-updater emits
        // 'update-downloaded' when ready. If autoDownload is true (default),
        // the download starts automatically after checkForUpdates resolves.
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("update download timed out after 120s"));
          }, 120_000);

          autoUpdater.once("update-downloaded", () => {
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
          });

          autoUpdater.once("error", (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });
      }
    } catch (err) {
      // Network error, update server down, etc. — don't block the boot.
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
      pct: 50,
    });

    // syncNotesFromDisk is synchronous but potentially slow for large
    // workspaces. We run it in a microtask to let the splash paint.
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        syncNotesFromDisk(ctx.db, ctx.workspacePath);
        resolve();
      });
    });

    notesSynced = 1; // syncNotesFromDisk doesn't return a count
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[boot] Notes sync failed:", msg);
    errors.push(`Notes sync: ${msg}`);
  }
  splash.stepDone("Notes sync");

  // ── Done ──────────────────────────────────────────────────────────────
  splash.progress({ step: "done", label: "Ready", pct: 100 });

  return { updateInstalled, migrationsRan, reindexed, notesSynced, errors };
}
