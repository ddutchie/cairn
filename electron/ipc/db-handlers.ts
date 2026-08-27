/**
 * Cairn — IPC handlers for DB CRUD channels (`db:*` that aren't flow/graph/chat).
 *
 * Mostly thin delegations to `q.*` from `db/queries.ts`. Note handlers write/
 * delete .md files in the workspace folder so the filesystem stays in sync with
 * SQLite.
 *
 * Extracted from the god-file `ipc/handlers.ts` (P2 of the cleanup plan).
 */

import { shell } from "electron";
import fs from "fs";
import path from "path";
import { registerIpcHandle, registerIpcOn, broadcastEvent } from "./registry";
import { resolveWithinRoot } from "./path-safety";
import { handle, getProjectName, type DbContext } from "./result-helpers";
import * as q from "../db/queries";
import { writeNoteFile, deleteNoteFile, hardDeleteNoteFile, deleteProjectNotesDir, renameProjectNotesDir, reconcileProjectFolders, findNoteFilePath } from "../notes-files";
import { suppressNextChange } from "../file-watcher";
import { executeTool as executeMcpTool } from "../mcp/tools";
import { executeReadTool } from "../lib/read-tools";
import { DEFAULT_COLUMNS } from "../db/defaults";
import { invalidateRelationshipCache, computeAutoRelationships, computeSemanticRelationships } from "../db/graph-queries";
import { reindexNotes, reindexTasks } from "../embeddings/service";
import { getDefaultModelId as getEmbeddingModelId } from "../embeddings/client";
import { getEmbeddingsSettingsCached } from "../lib/config-cache";
import {
  createAutomation,
  getAutomationById,
  getAutomationRunById,
  listAutomations,
  updateAutomation,
  deleteAutomation,
  listAutomationRuns,
  listRecentAutomationRuns,
  countRunningAutomationRuns,
  type AutomationEnv,
  type AutomationInput,
} from "../db/automation-queries";
import { runAutomationNow, resolveAutomationApproval } from "../lib/heartbeat-runner";
import { checkRequirements } from "../lib/external-tools";
import { parseSchedule, computeNextRun } from "../lib/automation-schedule";
import { automationFolderDir, ensureAutomationDir, listAutomationFolderFiles, readRunLog, removeAutomationDir } from "../lib/automation-folder";
import { applyManifestToAutomation, isValidEnvName, prepareAutomationFolder, readAutomationManifest } from "../lib/automation-env";
import { hasSecret, setSecret, deleteSecret, deleteToolSecrets } from "../lib/secure-store";

const reindexInFlight = new Map<string, Promise<boolean>>();

async function reindexSingleNoteEmbedding(ctx: DbContext, noteId: string, workspaceId: string): Promise<boolean> {
  const settings = getEmbeddingsSettingsCached();
  if (!settings?.enabled) return false;
  const model = settings.modelId || getEmbeddingModelId();

  const existing = reindexInFlight.get(noteId);
  if (existing) {
    await existing.catch(() => {});
  }

  const p = (async () => {
    try {
      await reindexNotes(ctx.db, workspaceId, [noteId], model);
      return true;
    } catch (e) {
      console.warn("[embeddings] incremental reindex failed:", e instanceof Error ? e.message : e);
      return false;
    }
  })();

  reindexInFlight.set(noteId, p);
  try {
    return await p;
  } finally {
    if (reindexInFlight.get(noteId) === p) reindexInFlight.delete(noteId);
  }
}

/** Incrementally (re)embed a single task card after a create/update — symmetric
 *  to reindexSingleNoteEmbedding. Fire-and-forget; no-op when embeddings off.
 *  Returns true when a reindex actually ran (embeddings enabled), so callers can
 *  gate a semantic-edge recompute on it. */
async function reindexSingleCardEmbedding(ctx: DbContext, cardId: string, workspaceId: string): Promise<boolean> {
  const settings = getEmbeddingsSettingsCached();
  if (!settings?.enabled) return false;
  const model = settings.modelId || getEmbeddingModelId();
  const key = `card:${cardId}`;
  const existing = reindexInFlight.get(key);
  if (existing) await existing.catch(() => {});
  const p = (async () => {
    try {
      await reindexTasks(ctx.db, workspaceId, [cardId], model);
      return true;
    } catch (e) {
      console.warn("[embeddings] incremental card reindex failed:", e instanceof Error ? e.message : e);
      return false;
    }
  })();
  reindexInFlight.set(key, p);
  try {
    return await p;
  } finally {
    if (reindexInFlight.get(key) === p) reindexInFlight.delete(key);
  }
}

/** After a card's embedding is refreshed, recompute the semantic edges that
 *  touch it (scoped to that card id). Cross-kind edges (note↔task) fall out of
 *  computeSemanticRelationships pooling notes + cards. */
function recomputeCardSemanticEdges(ctx: DbContext, cardId: string, workspaceId: string): void {
  void reindexSingleCardEmbedding(ctx, cardId, workspaceId).then((didReindex) => {
    if (!didReindex) return;
    try {
      computeSemanticRelationships(ctx.db, workspaceId, [cardId]);
    } catch (e) {
      console.warn("[embeddings] semantic recompute skipped:", e instanceof Error ? e.message : e);
    }
  }).catch(() => { /* already warned */ });
}

export function registerDbHandlers(ctx: DbContext): void {
  // ── Full snapshot (hydrate store on app launch) ───
  registerIpcHandle("db:snapshot", () => handle(() => q.getFullSnapshot(ctx.db)));
  registerIpcHandle("db:hasData", () => handle(() => q.hasData(ctx.db)));

  // ── Dashboard live query bridge ───────────────────
  // Executes read-only MCP-style tool calls from dashboard iframes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerIpcHandle("db:mcpQuery", (_e, { tool, args }: { tool: string; args: Record<string, any> }) => {
    return handle(() => {
      if (tool === "get_cairn_context") {
        return executeMcpTool(ctx.db, ctx.workspacePath, tool, args);
      }
      const snap = q.getFullSnapshot(ctx.db);
      const res = executeReadTool(ctx.db, snap, tool, args);
      if (res.handled) return res.result;
      throw new Error(`Unknown or disallowed tool: ${tool}`);
    });
  });

  // ── Workspaces ────────────────────────────────────
  registerIpcHandle("db:workspace:list", () => handle(() => q.getAllWorkspaces(ctx.db)));
  registerIpcHandle("db:workspace:create", (_e, args: Parameters<typeof q.createWorkspace>[1]) => handle(() => q.createWorkspace(ctx.db, args)));
  registerIpcHandle("db:workspace:update", (_e, { id, patch }) => handle(() => q.updateWorkspace(ctx.db, id, patch)));

  // ── Projects ──────────────────────────────────────
  registerIpcHandle("db:project:list", (_e, { workspaceId }) => handle(() => q.getProjects(ctx.db, workspaceId)));
  registerIpcHandle("db:project:create", (_e, args: Parameters<typeof q.createProject>[1] & { withDefaultColumns?: boolean }) => handle(() => {
    // Wrap project + default columns in a transaction so all columns succeed or none do.
    return ctx.db.transaction(() => {
      const project = q.createProject(ctx.db, args);
      if (args.withDefaultColumns) {
        const columns = DEFAULT_COLUMNS.map((col) =>
          q.createColumn(ctx.db, {
            id: q.generateId(),
            projectId: project.id,
            workspaceId: project.workspaceId,
            name: col.name,
            type: col.type,
            order: col.order,
          })
        );
        return { project, columns };
      }
      return { project, columns: [] };
    })();
  }));
  registerIpcHandle("db:project:update", (_e, { id, patch }) => handle(() => {
    // Capture the old name BEFORE the update so we can relocate the project's
    // on-disk notes directory when the name (and thus its slug) changes —
    // otherwise the .md files stay under the old slug and future writes split
    // the project across two folders on disk.
    const before = q.getProjectById(ctx.db, id);
    const project = q.updateProject(ctx.db, id, patch);
    if (before && project && before.name !== project.name) {
      // Primary path: move the old-slug directory to the new slug directly.
      const moved = renameProjectNotesDir(ctx.workspacePath, before.name, project.name);
      // Self-heal fallback: if the direct move was a no-op (e.g. the project had
      // no on-disk folder yet, its notes live at the vault root, or a concurrent
      // write raced the rename), run the same reconciliation the app does at
      // startup so any stranded old-slug folder is relocated immediately — the
      // user should never have to restart for the folder to follow the rename.
      if (!moved) reconcileProjectFolders(ctx.db, ctx.workspacePath);
    }
    return project;
  }));
  registerIpcHandle("db:project:updateSettings", (_e, { id, settings }: { id: string; settings: Record<string, unknown> }) => handle(() => q.updateProjectSettings(ctx.db, id, settings)));
  registerIpcHandle("db:project:delete", (_e, { id }) => handle(() => {
    const project = q.getProjectById(ctx.db, id);
    // Delete from DB first so if it fails, the .md files are still intact for recovery.
    q.deleteProject(ctx.db, id);
    if (project) {
      // The notes folder is keyed by the project NAME slug, not the id, and
      // names are not unique. Only remove the folder if no surviving project
      // still shares that slug — otherwise we'd wipe a duplicate's .md files.
      // Scope survivors to this project's workspace: folders live under this
      // workspace's tree, so a same-named project in ANOTHER workspace is not a
      // real survivor and must not block the delete.
      const survivorNames = q.getProjects(ctx.db, project.workspaceId).map((p) => p.name);
      deleteProjectNotesDir(ctx.workspacePath, project.name, survivorNames);
    }
  }));

  // Merge every entity of `sourceId` into `targetId`, then remove the source.
  // The DB repoint runs in one transaction (q.mergeProject); afterwards we
  // relocate each moved note's .md file into the target project's folder and
  // remove the now-empty source folder. File moves are best-effort: the
  // authoritative move already happened in SQLite, and startup
  // reconcileProjectFolders would heal any stragglers, but we do it eagerly so
  // the user doesn't have to restart.
  registerIpcHandle(
    "db:project:merge",
    (_e, { sourceId, targetId }: { sourceId: string; targetId: string }) =>
      handle(() => {
        const result = q.mergeProject(ctx.db, sourceId, targetId);

        // Relocate .md files: write each moved note into the TARGET folder (its
        // project_id/workspaceId now point at the target, so getProjectName
        // resolves the destination), then delete the source project's folder.
        if (result.sourceName !== result.targetName) {
          for (const moved of result.movedNotes) {
            if (moved.type === "dashboard") continue; // dashboards have no .md file
            const note = q.getNoteById(ctx.db, moved.id);
            if (!note) continue;
            try {
              suppressNextChange(note.id);
              writeNoteFile(ctx.workspacePath, {
                ...note,
                projectName: getProjectName(ctx.db, note.projectId),
              });
            } catch (e) {
              console.warn("[merge] failed to relocate note file:", e instanceof Error ? e.message : e);
            }
          }
          // Remove the source project's on-disk folder (now that its notes have
          // been rewritten under the target). Best-effort, and only when no
          // surviving project shares the source name's slug — scoped to the
          // target's workspace (both folders live under this workspace's tree).
          try {
            const mergeWsId = q.getProjectById(ctx.db, targetId)?.workspaceId;
            const survivorNames = q.getProjects(ctx.db, mergeWsId).map((p) => p.name);
            deleteProjectNotesDir(ctx.workspacePath, result.sourceName, survivorNames);
          } catch (e) {
            console.warn("[merge] failed to remove source project folder:", e instanceof Error ? e.message : e);
          }
          // Self-heal any stragglers (e.g. a note whose file write failed) so the
          // filesystem matches the DB without needing a restart.
          reconcileProjectFolders(ctx.db, ctx.workspacePath);
        }

        // Membership changed en masse → recompute relationships for the target
        // workspace so the graph/semantic links reflect the merged project.
        const target = q.getProjectById(ctx.db, targetId);
        if (target?.workspaceId) {
          const movedNoteIds = result.movedNotes.map((n) => n.id);
          if (movedNoteIds.length > 0) {
            for (const nid of movedNoteIds) invalidateRelationshipCache(ctx.db, nid);
            computeAutoRelationships(ctx.db, target.workspaceId, movedNoteIds);
          }
        }

        return result;
      }),
  );

  // ── Notes ─────────────────────────────────────────
  // All note mutations also write/update/delete the corresponding .md file.
  registerIpcHandle("db:note:list", (_e, { projectId }) => handle(() => q.getNotes(ctx.db, projectId)));

  registerIpcHandle("db:note:create", (_e, args: Parameters<typeof q.createNote>[1]) => handle(() => {
    const note = q.createNote(ctx.db, {
      ...args,
    });
    if (note.type !== "dashboard") {
      suppressNextChange(note.id);
      writeNoteFile(ctx.workspacePath, {
        ...note,
        projectName: getProjectName(ctx.db, note.projectId),
      });
    }
    return note;
  }));

  registerIpcHandle("db:note:update", (_e, { id, patch }) => handle(() => {
    // archivedAt: null means "restore" — COALESCE cannot clear to NULL
    if ("archivedAt" in patch && patch.archivedAt === null) {
      const rest = { ...patch };
      delete rest.archivedAt;
      // Wrap both SQL writes in a transaction so a crash between them leaves
      // the DB in a consistent state (either both applied or neither).
      const note = ctx.db.transaction(() => {
        if (Object.keys(rest).length > 0) {
          q.updateNote(ctx.db, id, rest);
        }
        return q.restoreNote(ctx.db, id);
      })();
      suppressNextChange(id);
      if (note.type !== "dashboard") {
        writeNoteFile(ctx.workspacePath, { ...note, projectName: getProjectName(ctx.db, note.projectId) });
      }
      return note;
    }
    // Did the title actually change? A title edit is an explicit rename → the
    // .md filename should be re-derived (renameFile:true) AND inbound
    // [[wikilinks]] in other notes rewritten, exactly like the MCP rename_note
    // tool. Every other update (content, tags, pin, links) must KEEP the
    // existing filename so we don't rename files out from under Obsidian
    // wikilinks. Compare against the current row BEFORE the update.
    const prevNote = q.getNoteById(ctx.db, id);
    const prevTitle = prevNote?.title;
    const titleChanged =
      typeof patch.title === "string" && patch.title !== prevTitle;
    // Suppress before the update so the watcher's unlink event (fired when
    // writeNoteFile renames the file) is ignored before it can delete the row.
    suppressNextChange(id);

    // Rewrite inbound wikilinks + apply the update in one transaction so a crash
    // can't leave the title changed but links dangling (or vice-versa).
    // Old link targets = the old title AND the note's on-disk filename stem
    // (adopted vault notes are often linked by filename, not title). Resolve the
    // filename before the update relocates it.
    let relinked: ReturnType<typeof q.updateNote>[] = [];
    let oldTargets: string[] = [];
    if (titleChanged && prevTitle) {
      const projName = getProjectName(ctx.db, prevNote!.projectId);
      const fp = findNoteFilePath(ctx.workspacePath, projName, id);
      const stem = fp ? path.basename(fp, ".md") : null;
      oldTargets = [prevTitle, ...(stem ? [stem] : [])];
    }
    const note = ctx.db.transaction(() => {
      const u = q.updateNote(ctx.db, id, patch);
      if (oldTargets.length > 0) {
        relinked = q.rewriteInboundWikilinks(ctx.db, id, oldTargets, patch.title as string);
      }
      return u;
    })();

    if (note.type !== "dashboard") {
      writeNoteFile(ctx.workspacePath, {
        ...note,
        projectName: getProjectName(ctx.db, note.projectId),
        renameFile: titleChanged,
      });
    }
    // Persist the .md files of every note whose wikilinks we rewrote. Suppress
    // each so the watcher doesn't echo our own write back into the DB. Each write
    // is isolated — a single failure must not abort the rest (the DB rewrite is
    // already committed; mirrors the db:project:merge relocation loop).
    for (const other of relinked) {
      if (other.type === "dashboard") continue;
      try {
        suppressNextChange(other.id);
        writeNoteFile(ctx.workspacePath, {
          ...other,
          projectName: getProjectName(ctx.db, other.projectId),
        });
      } catch (e) {
        console.warn("[note:update] failed to persist relinked note file:", e instanceof Error ? e.message : e);
      }
    }
    invalidateRelationshipCache(ctx.db, id);
    if (note.workspaceId) {
      computeAutoRelationships(ctx.db, note.workspaceId, [id]);
      void reindexSingleNoteEmbedding(ctx, id, note.workspaceId).then((didReindex) => {
        if (!didReindex) return;
        try {
          computeSemanticRelationships(ctx.db, note.workspaceId, [id]);
        } catch (e) {
          console.warn("[embeddings] semantic recompute skipped:", e instanceof Error ? e.message : e);
        }
      }).catch(() => { /* already warned */ });
    }
    return note;
  }));

  registerIpcHandle("db:note:moveToFolder", (_e, { id, folder }: { id: string; folder: string }) => handle(() => {
    // Use moveNoteFolder (direct SET) rather than updateNote (COALESCE) so that
    // moving a note to root (folder="") is never silently ignored.
    suppressNextChange(id);
    const note = q.moveNoteFolder(ctx.db, id, folder ?? "");
    if (note.type !== "dashboard") {
      writeNoteFile(ctx.workspacePath, { ...note, projectName: getProjectName(ctx.db, note.projectId) });
    }
    return note;
  }));

  registerIpcHandle(
    "db:note:moveToProject",
    (_e, { id, projectId }: { id: string; projectId: string; workspaceId?: string }) =>
      handle(() => {
        // Moving a note between projects was previously routed through
        // updateNote(), whose UPDATE has no project_id/workspace_id columns — so
        // the move was silently dropped and the note re-surfaced in the old
        // project (via a DB refresh, file-watcher re-import, or sync reconcile).
        // Persist the move with a dedicated direct-SET query, and — crucially —
        // relocate the .md file: writeNoteFile only unlinks a stale file it finds
        // *within the target project's* folder, so the old project's copy must be
        // deleted explicitly or the file-watcher will re-import it into the old
        // project.
        const before = q.getNoteById(ctx.db, id);
        if (!before) throw new Error(`Note not found: ${id}`);
        const oldProjectId = before.projectId;
        const oldProjectName = getProjectName(ctx.db, oldProjectId);

        // moveNoteToProject rejects a missing target project (and resolves the
        // authoritative workspace itself), so the DB move is validated before we
        // touch any files.
        suppressNextChange(id);
        const note = q.moveNoteToProject(ctx.db, id, projectId);

        if (note.type !== "dashboard" && oldProjectName !== getProjectName(ctx.db, projectId)) {
          // Failure-safe relocation: write the note into the NEW project folder
          // FIRST, then remove the old copy. If the write throws, roll the DB
          // row back to the old project so ownership and the on-disk file stay
          // consistent (the old file is still present and authoritative).
          try {
            writeNoteFile(ctx.workspacePath, { ...note, projectName: getProjectName(ctx.db, note.projectId) });
          } catch (e) {
            q.moveNoteToProject(ctx.db, id, oldProjectId);
            throw e;
          }
          // New file is in place; deleting the stale old copy is best-effort
          // (a failure here only leaves a duplicate that the watcher would
          // re-import into the old project — non-fatal, and the DB move stands).
          // Use a synchronous HARD delete (not the OS-trash remover): this is a
          // move-internal duplicate, not a user delete, so it must not land in
          // the Trash and must be gone before we return, or an async trasher
          // would race the file-watcher re-importing it into the old project.
          try {
            hardDeleteNoteFile(ctx.workspacePath, oldProjectName, id);
          } catch (e) {
            console.warn("[notes] failed to remove old-project file after move:", e instanceof Error ? e.message : e);
          }
        }

        // Membership changed → auto/semantic relationships and the embedding
        // index are scoped by workspace, so recompute for the new workspace.
        invalidateRelationshipCache(ctx.db, id);
        if (note.workspaceId) {
          computeAutoRelationships(ctx.db, note.workspaceId, [id]);
          void reindexSingleNoteEmbedding(ctx, id, note.workspaceId).then((didReindex) => {
            if (!didReindex) return;
            try {
              computeSemanticRelationships(ctx.db, note.workspaceId, [id]);
            } catch (e) {
              console.warn("[embeddings] semantic recompute skipped:", e instanceof Error ? e.message : e);
            }
          }).catch(() => { /* already warned */ });
        }
        return note;
      }),
  );

  registerIpcHandle("db:note:delete", (_e, { id }) => handle(() => {
    const note = q.getNoteById(ctx.db, id);
    if (note) {
      const projectName = getProjectName(ctx.db, note.projectId);
      q.deleteNote(ctx.db, id);
      if (note.type !== "dashboard") {
        deleteNoteFile(ctx.workspacePath, projectName, id);
      }
    } else {
      q.deleteNote(ctx.db, id);
    }
  }));

  // ── Open URL in default system browser ───────────
  registerIpcOn("app:openExternal", (_e, url: string) => {
    if (typeof url === "string" && (url.startsWith("https://") || url.startsWith("http://"))) {
      shell.openExternal(url);
    }
  });

  // ── Reveal in Finder / Explorer ───────────────────
  registerIpcHandle("app:revealNote", (_e, { noteId, projectId }) => handle(() => {
    const projectName = getProjectName(ctx.db, projectId);
    const fp = findNoteFilePath(ctx.workspacePath, projectName, noteId);
    if (fp) {
      shell.showItemInFolder(fp);
    }
  }));

  // ── Asset upload (paste images into notes) ────────
  // Saves to <workspace>/attachments/ with original filename (Obsidian-compatible).
  // Returns ![[filename]] syntax so images work in both Cairn and Obsidian.
  // Legacy asset:// URLs still render via the asset:// protocol handler.
  registerIpcHandle("app:uploadAsset", (_e, { filename, data }: { filename: string; data: ArrayBuffer }) =>
    handle(() => {
      // Determine attachment folder — read from Obsidian config if available
      let attachDir: string;
      const obsidianAppJson = path.join(ctx.workspacePath, ".obsidian", "app.json");
      try {
        if (fs.existsSync(obsidianAppJson)) {
          const obsConfig = JSON.parse(fs.readFileSync(obsidianAppJson, "utf-8"));
          if (typeof obsConfig.attachmentFolderPath === "string" && obsConfig.attachmentFolderPath) {
            const resolved = resolveWithinRoot(ctx.workspacePath, obsConfig.attachmentFolderPath);
            attachDir = resolved ?? path.join(ctx.workspacePath, "attachments");
          } else {
            // Obsidian default: vault root
            attachDir = path.join(ctx.workspacePath, "attachments");
          }
        } else {
          attachDir = path.join(ctx.workspacePath, "attachments");
        }
      } catch {
        attachDir = path.join(ctx.workspacePath, "attachments");
      }

      fs.mkdirSync(attachDir, { recursive: true });
      const buf = Buffer.from(data);
      if (buf.length > 10 * 1024 * 1024) throw new Error("file too large (max 10MB)");
      const ALLOWED_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".pdf"]);
      const ext = path.extname(filename).toLowerCase() || ".png";
      if (!ALLOWED_EXTS.has(ext)) throw new Error(`unsupported file type "${ext}"`);
      const baseName = path.basename(filename, ext).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "image";

      // Dedup: if filename already exists with different content, append suffix
      let destName = `${baseName}${ext}`;
      let destPath = path.join(attachDir, destName);
      let counter = 1;
      while (fs.existsSync(destPath)) {
        // Same content → reuse existing file
        if (fs.statSync(destPath).size === buf.length) {
          const existing = fs.readFileSync(destPath);
          if (buf.equals(existing)) break;
        }
        destName = `${baseName}-${counter}${ext}`;
        destPath = path.join(attachDir, destName);
        counter++;
      }

      if (!fs.existsSync(destPath)) {
        fs.writeFileSync(destPath, buf);
      }

      // Return Obsidian-compatible embed syntax
      return { assetUrl: `![[${destName}]]` };
    })
  );

  // ── Reveal assets folder in Finder / Explorer ─────
  registerIpcHandle("app:revealAssets", () => handle(async () => {
    const assetDir = path.join(ctx.workspacePath, "attachments");
    fs.mkdirSync(assetDir, { recursive: true });
    // shell.openPath returns a Promise<string>; non-empty = error message.
    const errMsg = await shell.openPath(assetDir);
    if (errMsg) console.error("[cairn:revealAssets]", errMsg);
  }));

  // ── Board columns ─────────────────────────────────
  registerIpcHandle("db:column:list", (_e, { projectId }) => handle(() => q.getColumns(ctx.db, projectId)));
  registerIpcHandle("db:column:create", (_e, args: Parameters<typeof q.createColumn>[1]) => handle(() => q.createColumn(ctx.db, args)));
  registerIpcHandle("db:column:update", (_e, { id, patch }) => handle(() => q.updateColumn(ctx.db, id, patch)));
  registerIpcHandle("db:column:delete", (_e, { id }) => handle(() => q.deleteColumn(ctx.db, id)));

  // ── Task cards ────────────────────────────────────
  registerIpcHandle("db:card:list", (_e, opts: Parameters<typeof q.getCards>[1]) => handle(() => q.getCards(ctx.db, opts)));
  registerIpcHandle("db:card:create", (_e, args: Parameters<typeof q.createCard>[1]) => handle(() => {
    const title = (args?.title as string | null | undefined)?.trim();
    if (!title) throw new Error("Task title is required");
    const card = q.createCard(ctx.db, { ...args, title });
    if (card.workspaceId) recomputeCardSemanticEdges(ctx, card.id, card.workspaceId);
    return card;
  }));
  registerIpcHandle("db:card:update", (_e, { id, patch }) => handle(() => {
    // archivedAt: null means "restore" — COALESCE cannot clear to NULL
    if ("archivedAt" in patch && patch.archivedAt === null) {
      const rest = { ...patch };
      delete rest.archivedAt;
      const card = ctx.db.transaction(() => {
        if (Object.keys(rest).length > 0) {
          q.updateCard(ctx.db, id, rest);
        }
        return q.restoreCard(ctx.db, id);
      })();
      // A restored card must be re-embedded — archiving removed it from search
      // (below), so restoring has to bring it back.
      if (card.workspaceId) recomputeCardSemanticEdges(ctx, id, card.workspaceId);
      return card;
    }
    const card = q.updateCard(ctx.db, id, patch);
    invalidateRelationshipCache(ctx.db, id);
    // A resolved blocker (archived, or moved to a done column) must leave every
    // other card's blocked_by_ids — otherwise get_task/list_ready_tasks keep
    // reporting stale refs. Archiving is also a soft delete (row stays, so the
    // FK cascade doesn't fire) — drop its embeddings too so an archived card
    // can't surface in semantic search.
    if (card.archivedAt) {
      q.clearBlockersFromAll(ctx.db, [id]);
      q.deleteTaskEmbeddingSections(ctx.db, id);
      return card;
    }
    // Restore the done-column cleanup dropped in the IPC split (011ab827) —
    // the renderer drag-and-drop path (db:card:update { columnId }) previously
    // removed the moved card from other tasks' blocked_by_ids.
    if (patch.columnId) {
      const col = ctx.db
        .prepare("SELECT type FROM board_columns WHERE id = ?")
        .get(patch.columnId) as { type: string } | undefined;
      if (col?.type === "done") q.clearBlockersFromAll(ctx.db, [id]);
    }
    if (card.workspaceId) {
      computeAutoRelationships(ctx.db, card.workspaceId, [id]);
      recomputeCardSemanticEdges(ctx, id, card.workspaceId);
    }
    return card;
  }));
  registerIpcHandle("db:card:delete", (_e, { id }) => handle(() => q.deleteCard(ctx.db, id)));

  registerIpcHandle(
    "db:card:moveToProject",
    (_e, { id, projectId, columnId, order }: { id: string; projectId: string; columnId: string; order: number }) =>
      handle(() => {
        // Cross-project card moves previously went through updateCard(), whose
        // UPDATE has no project_id/workspace_id columns — so the move was
        // silently dropped and the card re-surfaced in the old project (board
        // reads and sync reconcile both scope by project_id). Persist it with a
        // dedicated direct-SET query that also validates the target column
        // belongs to the target project.
        const card = q.moveCardToProject(ctx.db, id, projectId, columnId, order);
        // Membership changed → relationships/semantic edges are workspace-scoped,
        // so recompute for the (possibly new) workspace.
        invalidateRelationshipCache(ctx.db, id);
        if (card.workspaceId) {
          computeAutoRelationships(ctx.db, card.workspaceId, [id]);
          recomputeCardSemanticEdges(ctx, id, card.workspaceId);
        }
        return card;
      }),
  );

  registerIpcHandle("db:cards:archive-done", (_e, { columnId }: { columnId: string }) => handle(() => {
    const cards = q.getCards(ctx.db, { columnId });
    const now = new Date().toISOString();
    for (const c of cards) {
      q.updateCard(ctx.db, c.id, { archivedAt: now, columnId });
      // Drop cached relationship edges + embeddings for the archived card so it
      // leaves both the graph and semantic search (soft delete → no FK cascade),
      // mirroring the db:card:update archive path.
      invalidateRelationshipCache(ctx.db, c.id);
      q.deleteTaskEmbeddingSections(ctx.db, c.id);
    }
    // Archived cards no longer block anything — clear them from other tasks'
    // blocked_by_ids (same rule as single-card archive / move-to-done).
    q.clearBlockersFromAll(ctx.db, cards.map((c) => c.id));
    return { archived: cards.length };
  }));

  // Blocker management (circular dep check at the IPC layer; queries.ts handles SQL).
  registerIpcHandle("db:card:addBlocker", (_e, { cardId, blockerCardId }) => handle(() => {
    const card = q.getCardById(ctx.db, cardId);
    if (!card) throw new Error("Card not found");
    const blocker = q.getCardById(ctx.db, blockerCardId);
    if (!blocker) throw new Error("Blocker card not found");
    if (card.projectId !== blocker.projectId) throw new Error("Cards must be in the same project");
    if (cardId === blockerCardId) throw new Error("A card cannot block itself");
    // Circular dep check — could be extracted to a queries.ts helper later.
    const projectCards = q.getCards(ctx.db, { projectId: card.projectId });
    const cardMap = new Map(projectCards.map((c) => [c.id, c]));
    function canReach(from: string, target: string, visited = new Set<string>()): boolean {
      if (from === target) return true;
      if (visited.has(from)) return false;
      visited.add(from);
      const node = cardMap.get(from);
      if (!node) return false;
      return (node.blockedByIds ?? []).some((bid) => canReach(bid, target, visited));
    }
    if (canReach(blockerCardId, cardId, new Set())) {
      throw new Error("Circular dependency detected");
    }
    return q.addCardBlocker(ctx.db, cardId, blockerCardId);
  }));

  registerIpcHandle("db:card:removeBlocker", (_e, { cardId, blockerCardId }) => handle(() =>
    q.removeCardBlocker(ctx.db, cardId, blockerCardId)
  ));

  registerIpcHandle("db:card:ready", (_e, { projectId }) => handle(() =>
    q.getReadyCards(ctx.db, projectId)
  ));

  // ── Tags ──────────────────────────────────────────
  registerIpcHandle("db:tag:list", (_e, { workspaceId }) => handle(() => q.getTags(ctx.db, workspaceId)));
  registerIpcHandle("db:tag:create", (_e, args: Parameters<typeof q.createTag>[1]) => handle(() => q.createTag(ctx.db, args)));
  registerIpcHandle("db:tag:update", (_e, { id, patch }) => handle(() => q.updateTag(ctx.db, id, patch)));
  registerIpcHandle("db:tag:delete", (_e, { id }) => handle(() => q.deleteTag(ctx.db, id)));

  // ── Slash commands ─────────────────────────────────
  registerIpcHandle("db:command:list", (_e, { workspaceId }) => handle(() => q.getSlashCommands(ctx.db, workspaceId)));
  registerIpcHandle("db:command:create", (_e, args: Parameters<typeof q.createSlashCommand>[1]) => handle(() => q.createSlashCommand(ctx.db, args)));
  registerIpcHandle("db:command:update", (_e, { id, patch }) => handle(() => q.updateSlashCommand(ctx.db, id, patch)));
  registerIpcHandle("db:command:delete", (_e, { id }) => handle(() => q.deleteSlashCommand(ctx.db, id)));

  // ── Heartbeat automations ─────────────────────────
  registerIpcHandle("db:automation:list", (_e, { workspaceId }) => handle(() => listAutomations(ctx.db, workspaceId)));
  registerIpcHandle("db:automation:get", (_e, { id }) => handle(() => getAutomationById(ctx.db, id)));
  registerIpcHandle("db:automation:create", (_e, args: AutomationInput) => handle(() => {
    const input = { ...args };
    if (!input.nextRunAt) {
      try {
        const next = computeNextRun(parseSchedule(input.scheduleExpr), new Date(), input.timezone ?? undefined);
        // A schedule with no future occurrence (e.g. a 'once' in the past) is
        // created disabled rather than "due now" (which would fire once then
        // disable itself).
        if (!next) return { error: "Schedule has no future run time." };
        input.nextRunAt = next.toISOString();
      } catch (err) {
        return { error: err instanceof Error ? err.message : "Invalid schedule expression." };
      }
    }
    return createAutomation(ctx.db, input);
  }));
  registerIpcHandle("db:automation:update", (_e, { id, patch }: { id: string; patch: Partial<Omit<AutomationInput, "workspaceId">> }) => handle(() => {
    // Recompute next_run_at when the schedule/timezone changes.
    if (patch.scheduleKind !== undefined || patch.scheduleExpr !== undefined || patch.timezone !== undefined) {
      const existing = getAutomationById(ctx.db, id);
      if (existing) {
        const expr = patch.scheduleExpr ?? existing.scheduleExpr;
        const tz = patch.timezone === undefined ? existing.timezone : patch.timezone;
        try {
          const next = computeNextRun(parseSchedule(expr), new Date(), tz ?? undefined);
          // No future occurrence → leave next_run_at untouched (matches the
          // invalid-expression catch below); the automation disables on its
          // next tick rather than being stamped "due now".
          if (next) patch.nextRunAt = next.toISOString();
        } catch {
          // Invalid schedule — leave next_run_at unchanged; the update still proceeds.
        }
      }
    }
    return updateAutomation(ctx.db, id, patch);
  }));
  registerIpcHandle("db:automation:delete", (_e, { id }) => handle(() => {
    // Resolve the automation's folder on disk BEFORE deleting the row so we can
    // remove it too — the folder (<project>/.automations/<id>/) holds scripts/,
    // out/, .env, manifest.json, and every run's transcript + scratch, so an
    // orphaned folder would otherwise linger on disk after the automation is gone.
    const a = getAutomationById(ctx.db, id);
    if (!a) return { ok: false, deleted: false };
    const projectName = a.projectId ? getProjectName(ctx.db, a.projectId) : null;
    const folder = automationFolderDir(ctx.workspacePath, a.id, projectName);
    const deleted = deleteAutomation(ctx.db, id);
    if (deleted) {
      // Also purge the automation's keychain secrets (env secrets live in the OS
      // keychain, not the DB — deleting the row alone would orphan them).
      try {
        deleteToolSecrets("automation", id);
      } catch (err) {
        console.warn(`[automation] failed to purge secrets for deleted automation ${id}:`, err);
      }
      // Best-effort: an unremovable folder (permissions, open handle) must not
      // fail the delete — the DB row is already gone, so just warn.
      try {
        if (!removeAutomationDir(folder)) {
          console.warn(`[automation] failed to remove folder for deleted automation ${id}: ${folder}`);
        }
      } catch (err) {
        console.warn(`[automation] failed to remove folder for deleted automation ${id}:`, err);
      }
    }
    return { ok: true, deleted };
  }));
  registerIpcHandle("db:automation:runs", (_e, { automationId, limit }: { automationId: string; limit?: number }) => handle(() => listAutomationRuns(ctx.db, automationId, limit)));
  registerIpcHandle("db:automation:recentRuns", (_e, { workspaceId, projectId, limit }: { workspaceId: string; projectId?: string | null; limit?: number }) => handle(() => listRecentAutomationRuns(ctx.db, workspaceId, projectId ?? null, limit ?? 10)));
  registerIpcHandle("db:automation:runningCount", () => handle(() => countRunningAutomationRuns(ctx.db)));
  registerIpcHandle("db:automation:checkRequirements", (_e, { workspaceId, projectId, requires }: { workspaceId: string; projectId?: string | null; requires: Array<{ kind: "mcp" | "service"; name: string }> }) =>
    handle(() => checkRequirements(ctx.db, workspaceId, projectId ?? "", requires)),
  );
  registerIpcHandle("db:automation:runNow", (_e, { id }) => handle(() => {
    const runId = runAutomationNow({
      db: ctx.db,
      workspacePath: ctx.workspacePath,
      send: (channel, payload) => broadcastEvent(channel, payload),
    }, id);
    return runId === null ? { skipped: true } : { runId };
  }));

  // Resolve a pending tool approval for a running automation (Cordis engine).
  // The renderer fires this when the user approves/denies a gated tool; it
  // resolves the coding agent's approval seam. grant "session" remembers for
  // the turn; "always" persists an "always allow" standing rule on the automation.
  registerIpcOn("automation:approve", (_e, { callId, approved, grant }: { callId: string; approved: boolean; grant?: "session" | "always" }) => {
    resolveAutomationApproval(callId, approved, grant);
  });

  // The automation's folder on disk (<project>/.automations/<id>/) — the dev
  // agent's cwd when building/testing the automation's scripts. The folder is
  // CREATED here (scripts/ + out/ + .env + manifest) so a Develop session on a
  // never-run automation sees a real, populated workspace.
  registerIpcHandle("db:automation:folder", (_e, { id }: { id: string }) => handle(() => {
    const a = getAutomationById(ctx.db, id);
    if (!a) return { error: "Automation not found." };
    const projectName = a.projectId ? getProjectName(ctx.db, a.projectId) : null;
    const folder = automationFolderDir(ctx.workspacePath, a.id, projectName);
    try {
      ensureAutomationDir(folder);
      prepareAutomationFolder(folder, a);
    } catch (err) {
      console.warn("[automation] failed to prepare develop folder:", err);
    }
    return { folder };
  }));

  // File tree of the automation folder — for the Develop modal's "files" panel.
  registerIpcHandle("db:automation:files", (_e, { id }: { id: string }) => handle(() => {
    const a = getAutomationById(ctx.db, id);
    if (!a) return { error: "Automation not found." };
    const projectName = a.projectId ? getProjectName(ctx.db, a.projectId) : null;
    const folder = automationFolderDir(ctx.workspacePath, a.id, projectName);
    return { files: listAutomationFolderFiles(folder) };
  }));

  // A run's persisted transcript (run-log.json in its run folder).
  registerIpcHandle("db:automation:runLog", (_e, { runId }: { runId: string }) => handle(() => {
    const run = getAutomationRunById(ctx.db, runId);
    if (!run || !run.runDir) return { error: "No run folder for this run." };
    const log = readRunLog(run.runDir);
    if (!log) return { error: "No run transcript saved for this run." };
    return { log };
  }));

  // Apply the agent-authored manifest.json (instructions / env schema / standing
  // rules) back onto the automation row — the Develop loop's "write the resulting
  // automation shape" step.
  registerIpcHandle("db:automation:syncFromManifest", (_e, { id }: { id: string }) => handle(() => {
    const a = getAutomationById(ctx.db, id);
    if (!a) return { error: "Automation not found." };
    const projectName = a.projectId ? getProjectName(ctx.db, a.projectId) : null;
    const folder = automationFolderDir(ctx.workspacePath, a.id, projectName);
    const manifest = readAutomationManifest(folder);
    if (!manifest) return { error: "No manifest.json in the automation folder — run Develop first." };
    // Map the manifest onto the row: instructions / env / standing rules
    // (sanitised — target-less run_script/bash rules are dropped) / requires.
    const { patch, dropped } = applyManifestToAutomation(a, manifest);
    const updated = updateAutomation(ctx.db, id, patch);
    if (!updated) return { error: "Failed to sync automation from manifest." };
    return { automation: updated, dropped };
  }));

  // ── Automation env vars ──────────────────────────────────────────────────
  // Non-secret values are stored inline on the automation row; secret values
  // live in the OS keychain (kind "automation") and are NEVER returned to the
  // renderer — only a "set" boolean is exposed.
  const envSpec = (a: { id: string; env: AutomationEnv[] }) =>
    a.env.map((e) => e.secret
      ? { name: e.name, secret: true, set: hasSecret("automation", a.id, e.name) }
      : { name: e.name, secret: false, value: e.value ?? "" });

  registerIpcHandle("db:automation:env", (_e, { automationId }: { automationId: string }) => handle(() => {
    const a = getAutomationById(ctx.db, automationId);
    if (!a) return { error: "Automation not found." };
    return envSpec(a);
  }));

  registerIpcHandle("db:automation:env:set", (_e, { automationId, name, value, secret }: { automationId: string; name: string; value: string; secret: boolean }) => handle(() => {
    if (!isValidEnvName(name)) {
      return { error: `Invalid env var name "${name}" — use only letters, digits and underscores.` };
    }
    const a = getAutomationById(ctx.db, automationId);
    if (!a) return { error: "Automation not found." };
    if (secret) {
      // Secret → keychain only; the row keeps the name + flag with a null value.
      try {
        setSecret("automation", automationId, name, value);
      } catch (err) {
        return { error: err instanceof Error ? err.message : "Failed to store secret." };
      }
      updateAutomation(ctx.db, automationId, {
        env: [...a.env.filter((e) => e.name !== name), { name, secret: true }],
      });
    } else {
      updateAutomation(ctx.db, automationId, {
        env: [...a.env.filter((e) => e.name !== name), { name, secret: false, value }],
      });
    }
    const updated = getAutomationById(ctx.db, automationId);
    return updated ? envSpec(updated) : [];
  }));

  registerIpcHandle("db:automation:env:delete", (_e, { automationId, name }: { automationId: string; name: string }) => handle(() => {
    const a = getAutomationById(ctx.db, automationId);
    if (!a) return { error: "Automation not found." };
    deleteSecret("automation", automationId, name);
    updateAutomation(ctx.db, automationId, { env: a.env.filter((e) => e.name !== name) });
    const updated = getAutomationById(ctx.db, automationId);
    return updated ? envSpec(updated) : [];
  }));

  // Friendly schedule preview — compute the next fire time for a proposed
  // schedule expression (used by the Automations schedule builder).
  registerIpcHandle("db:automation:preview", (_e, { scheduleExpr, timezone }: { scheduleKind?: string; scheduleExpr: string; timezone?: string | null }) => handle(() => {
    try {
      const next = computeNextRun(parseSchedule(scheduleExpr), new Date(), timezone ?? undefined);
      return { nextRunAt: next ? next.toISOString() : null };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }));

  // ── Approval inbox ──────────────────────────────

  // ── In-app notification center ─────────────────
  registerIpcHandle("db:notification:list", (_e, { limit }: { limit?: number }) => handle(() => q.listMcpNotifications(ctx.db, limit)));
  registerIpcHandle("db:notification:count", () => handle(() => q.countUnreadMcpNotifications(ctx.db)));
  registerIpcHandle("db:notification:markRead", (_e, { id }: { id: string }) => handle(() => {
    q.markMcpNotificationRead(ctx.db, id);
    broadcastEvent("mcp:unread-count", q.countUnreadMcpNotifications(ctx.db));
    return true;
  }));
  registerIpcHandle("db:notification:clear", () => handle(() => {
    const n = q.clearMcpNotifications(ctx.db);
    broadcastEvent("mcp:unread-count", 0);
    return n;
  }));
}
