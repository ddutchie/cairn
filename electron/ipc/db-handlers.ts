/**
 * Cairn — IPC handlers for DB CRUD channels (`db:*` that aren't flow/graph/chat).
 *
 * Mostly thin delegations to `q.*` from `db/queries.ts`. Note handlers write/
 * delete .md files in the workspace folder so the filesystem stays in sync with
 * SQLite.
 *
 * Extracted from the god-file `ipc/handlers.ts` (P2 of the cleanup plan).
 */

import { registerContractHandle, registerIpcHandle, broadcastEvent } from "./registry";
import { handle, getProjectName, type DbContext } from "./result-helpers";
import * as q from "../db/queries";
import { writeNoteFile, deleteProjectNotesDir, renameProjectNotesDir, reconcileProjectFolders } from "../notes-files";
import { suppressNextChange } from "../file-watcher";
import { executeTool as executeMcpTool } from "../mcp/tools";
import { executeReadTool } from "../lib/read-tools";
import { DEFAULT_COLUMNS } from "../db/defaults";
import { invalidateRelationshipCache, computeAutoRelationships } from "../db/graph-queries";
import { registerNoteHandlers } from "./db-note-handlers";
import { registerBoardHandlers } from "./db-board-handlers";
import { registerAutomationHandlers } from "./db-automation-handlers";

export function registerDbHandlers(ctx: DbContext): void {
  // ── Full snapshot (hydrate store on app launch) ───
  registerIpcHandle("db:snapshot", (_e, opts?: { noteBodies?: boolean }) =>
    handle(() => (opts?.noteBodies === false ? q.getRendererSnapshot(ctx.db) : q.getFullSnapshot(ctx.db))));

  // ── Lazy note bodies (renderer keeps metadata, loads bodies on demand) ───
  registerContractHandle("db:note:bodies:get", (_e, { ids }: { ids: string[] }) =>
    handle(() => q.getNoteBodies(ctx.db, Array.isArray(ids) ? ids : [])));
  registerContractHandle("db:note:search", (_e, { query, projectId }: { query: string; projectId?: string }) =>
    handle(() => q.searchNoteIds(ctx.db, String(query ?? ""), { projectId })));
  registerContractHandle("db:note:changeMark:clear", (_e, { id }: { id: string }) =>
    handle(() => q.clearNoteChangeBase(ctx.db, id)));
  registerContractHandle("db:note:backlinks:list", (_e, { noteId }: { noteId: string }) =>
    handle(() => q.wikilinkBacklinkIds(ctx.db, noteId)));
  registerIpcHandle("db:hasData", () => handle(() => q.hasData(ctx.db)));

  // ── Change feed (incremental refresh on db:changed) ───
  // `get` is a read verb, so the registry never re-broadcasts db:changed for it.
  registerIpcHandle("db:changes:get", (e, args: { since: number | null; feedId: string | null }) =>
    handle(() => q.getChangesSince(ctx.db, args?.since ?? null, args?.feedId ?? null, e?.sender?.id)));

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
  registerContractHandle("db:workspace:list", () => handle(() => q.getAllWorkspaces(ctx.db)));
  registerContractHandle("db:workspace:create", (_e, args) => handle(() => q.createWorkspace(ctx.db, args)));
  registerContractHandle("db:workspace:update", (_e, { id, patch }) => handle(() => q.updateWorkspace(ctx.db, id, patch)));

  // ── Projects ──────────────────────────────────────
  registerContractHandle("db:project:list", (_e, { workspaceId }) => handle(() => q.getProjects(ctx.db, workspaceId)));
  registerContractHandle("db:project:create", (_e, args) => handle(() => {
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
  registerContractHandle("db:project:update", (_e, { id, patch }) => handle(() => {
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
  registerContractHandle("db:project:updateSettings", (_e, { id, settings }) => handle(() => q.updateProjectSettings(ctx.db, id, settings)));
  registerContractHandle("db:project:delete", (_e, { id }) => handle(() => {
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
  registerContractHandle(
    "db:project:merge",
    (_e, { sourceId, targetId }) =>
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

  registerNoteHandlers(ctx);

  registerBoardHandlers(ctx);

  // ── Tags ──────────────────────────────────────────
  registerContractHandle("db:tag:list", (_e, { workspaceId }) => handle(() => q.getTags(ctx.db, workspaceId)));
  registerContractHandle("db:tag:create", (_e, args) => handle(() => q.createTag(ctx.db, args)));
  registerContractHandle("db:tag:update", (_e, { id, patch }) => handle(() => q.updateTag(ctx.db, id, patch)));
  registerContractHandle("db:tag:delete", (_e, { id }) => handle(() => q.deleteTag(ctx.db, id)));

  // ── Slash commands ─────────────────────────────────
  registerIpcHandle("db:command:list", (_e, { workspaceId }) => handle(() => q.getSlashCommands(ctx.db, workspaceId)));
  registerIpcHandle("db:command:create", (_e, args: Parameters<typeof q.createSlashCommand>[1]) => handle(() => q.createSlashCommand(ctx.db, args)));
  registerIpcHandle("db:command:update", (_e, { id, patch }) => handle(() => q.updateSlashCommand(ctx.db, id, patch)));
  registerIpcHandle("db:command:delete", (_e, { id }) => handle(() => q.deleteSlashCommand(ctx.db, id)));

  registerAutomationHandlers(ctx);

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
