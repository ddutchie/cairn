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
import { registerIpcHandle, registerIpcOn } from "./registry";
import { handle, getProjectName, type DbContext } from "./result-helpers";
import * as q from "../db/queries";
import { writeNoteFile, deleteNoteFile, deleteProjectNotesDir, stripMarkdown, findNoteFilePath } from "../notes-files";
import { suppressNextChange } from "../file-watcher";
import { executeTool as executeMcpTool } from "../mcp/tools";
import { executeReadTool } from "../lib/read-tools";
import { DEFAULT_COLUMNS } from "../db/defaults";
import { invalidateRelationshipCache, computeAutoRelationships, computeSemanticRelationships } from "../db/graph-queries";
import { reindexNotes, reindexTasks } from "../embeddings/service";
import { getDefaultModelId as getEmbeddingModelId } from "../embeddings/client";
import { getEmbeddingsSettingsCached } from "../lib/config-cache";

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
  registerIpcHandle("db:project:update", (_e, { id, patch }) => handle(() => q.updateProject(ctx.db, id, patch)));
  registerIpcHandle("db:project:updateSettings", (_e, { id, settings }: { id: string; settings: Record<string, unknown> }) => handle(() => q.updateProjectSettings(ctx.db, id, settings)));
  registerIpcHandle("db:project:delete", (_e, { id }) => handle(() => {
    const project = q.getProjectById(ctx.db, id);
    // Delete from DB first so if it fails, the .md files are still intact for recovery.
    q.deleteProject(ctx.db, id);
    if (project) {
      deleteProjectNotesDir(ctx.workspacePath, project.name);
    }
  }));

  // ── Notes ─────────────────────────────────────────
  // All note mutations also write/update/delete the corresponding .md file.
  registerIpcHandle("db:note:list", (_e, { projectId }) => handle(() => q.getNotes(ctx.db, projectId)));

  registerIpcHandle("db:note:create", (_e, args: Parameters<typeof q.createNote>[1]) => handle(() => {
    const note = q.createNote(ctx.db, {
      ...args,
      contentText: stripMarkdown(args.content ?? ""),
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
          const enrichedRest = { ...rest };
          if (rest.content !== undefined && rest.contentText === undefined) {
            enrichedRest.contentText = stripMarkdown(rest.content);
          }
          q.updateNote(ctx.db, id, enrichedRest);
        }
        return q.restoreNote(ctx.db, id);
      })();
      suppressNextChange(id);
      if (note.type !== "dashboard") {
        writeNoteFile(ctx.workspacePath, { ...note, projectName: getProjectName(ctx.db, note.projectId) });
      }
      return note;
    }
    const enrichedPatch = { ...patch };
    if (patch.content !== undefined && patch.contentText === undefined) {
      enrichedPatch.contentText = stripMarkdown(patch.content);
    }
    // Suppress before the update so the watcher's unlink event (fired when
    // writeNoteFile renames the file) is ignored before it can delete the row.
    suppressNextChange(id);
    const note = q.updateNote(ctx.db, id, enrichedPatch);
    if (note.type !== "dashboard") {
      writeNoteFile(ctx.workspacePath, {
        ...note,
        projectName: getProjectName(ctx.db, note.projectId),
      });
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
    (_e, { id, projectId, workspaceId }: { id: string; projectId: string; workspaceId: string }) =>
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
        const oldProjectName = getProjectName(ctx.db, before.projectId);

        suppressNextChange(id);
        const note = q.moveNoteToProject(ctx.db, id, projectId, workspaceId);

        if (note.type !== "dashboard") {
          // Remove the note's file from the OLD project folder (its id-matched
          // copy), then write it fresh under the NEW project folder.
          if (oldProjectName !== getProjectName(ctx.db, projectId)) {
            deleteNoteFile(ctx.workspacePath, oldProjectName, id);
          }
          writeNoteFile(ctx.workspacePath, { ...note, projectName: getProjectName(ctx.db, note.projectId) });
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
            attachDir = path.join(ctx.workspacePath, obsConfig.attachmentFolderPath);
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
      const ext = path.extname(filename).toLowerCase() || ".png";
      const baseName = path.basename(filename, ext);

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
    // Archiving is a soft delete (row stays, so the FK cascade doesn't fire) —
    // drop its embeddings so an archived card can't surface in semantic search.
    if (card.archivedAt) {
      q.deleteTaskEmbeddingSections(ctx.db, id);
      return card;
    }
    if (card.workspaceId) {
      computeAutoRelationships(ctx.db, card.workspaceId, [id]);
      recomputeCardSemanticEdges(ctx, id, card.workspaceId);
    }
    return card;
  }));
  registerIpcHandle("db:card:delete", (_e, { id }) => handle(() => q.deleteCard(ctx.db, id)));

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
}
