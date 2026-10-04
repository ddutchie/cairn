/** Board columns and task cards (incl. blockers, archive). Split out of db-handlers.ts. */

import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import * as q from "../db/queries";
import { invalidateRelationshipCache, computeAutoRelationships } from "../db/graph-queries";
import { recomputeCardSemanticEdges } from "./embedding-reindex";

export function registerBoardHandlers(ctx: DbContext): void {
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
}
