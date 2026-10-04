/** Notes, note files, and note assets (reveal / upload). Split out of db-handlers.ts. */

import { shell } from "electron";
import fs from "fs";
import path from "path";
import { registerContractHandle, registerIpcHandle, registerIpcOn } from "./registry";
import { resolveWithinRoot } from "./path-safety";
import { handle, getProjectName, type DbContext } from "./result-helpers";
import * as q from "../db/queries";
import { writeNoteFile, deleteNoteFile, hardDeleteNoteFile, findNoteFilePath } from "../notes-files";
import { suppressNextChange } from "../file-watcher";
import { invalidateRelationshipCache, computeAutoRelationships, computeSemanticRelationships } from "../db/graph-queries";
import { reindexSingleNoteEmbedding } from "./embedding-reindex";

export function registerNoteHandlers(ctx: DbContext): void {
  // ── Notes ─────────────────────────────────────────
  // All note mutations also write/update/delete the corresponding .md file.
  registerContractHandle("db:note:list", (_e, { projectId }) => handle(() => q.getNotes(ctx.db, projectId)));

  registerContractHandle("db:note:create", (_e, args: Parameters<typeof q.createNote>[1]) => handle(() => {
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

  registerContractHandle("db:note:update", (_e, { id, patch }) => handle(() => {
    // archivedAt: null means "restore" — COALESCE cannot clear to NULL
    const { archivedAt, ...rest } = patch;
    if (archivedAt === null) {
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
      const u = q.updateNote(ctx.db, id, archivedAt === undefined ? rest : { ...rest, archivedAt });
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
      // Relinked notes' bodies changed too (their [[Old]] became [[New]]).
      computeAutoRelationships(ctx.db, note.workspaceId, [id, ...relinked.map((r) => r.id)]);
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

  registerContractHandle("db:note:moveToFolder", (_e, { id, folder }: { id: string; folder: string }) => handle(() => {
    // Use moveNoteFolder (direct SET) rather than updateNote (COALESCE) so that
    // moving a note to root (folder="") is never silently ignored.
    suppressNextChange(id);
    const note = q.moveNoteFolder(ctx.db, id, folder ?? "");
    if (note.type !== "dashboard") {
      writeNoteFile(ctx.workspacePath, { ...note, projectName: getProjectName(ctx.db, note.projectId) });
    }
    return note;
  }));

  registerContractHandle(
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

  registerContractHandle("db:note:delete", (_e, { id }) => handle(() => {
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
    // A tombstoned note must leave the knowledge graph immediately — the
    // graph loader only renders live nodes, but stale relationship_cache rows
    // and embeddings for the deleted id would otherwise linger.
    invalidateRelationshipCache(ctx.db, id);
    try {
      q.deleteNoteEmbedding(ctx.db, id);
    } catch (err) {
      console.warn(`[note:delete] failed to purge embeddings for ${id}:`, err);
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
}
