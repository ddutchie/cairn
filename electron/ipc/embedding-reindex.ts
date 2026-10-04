/**
 * Incremental embedding reindex for a single note / card after an edit, plus
 * card semantic-edge recompute. Shared by the note and board IPC handlers.
 */

import { type DbContext } from "./result-helpers";
import { computeSemanticRelationships } from "../db/graph-queries";
import { reindexNotes, reindexTasks } from "../embeddings/service";
import { getDefaultModelId as getEmbeddingModelId } from "../embeddings/client";
import { getEmbeddingsSettingsCached } from "../lib/config-cache";

const reindexInFlight = new Map<string, Promise<boolean>>();

export async function reindexSingleNoteEmbedding(ctx: DbContext, noteId: string, workspaceId: string): Promise<boolean> {
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
export async function reindexSingleCardEmbedding(ctx: DbContext, cardId: string, workspaceId: string): Promise<boolean> {
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
export function recomputeCardSemanticEdges(ctx: DbContext, cardId: string, workspaceId: string): void {
  void reindexSingleCardEmbedding(ctx, cardId, workspaceId).then((didReindex) => {
    if (!didReindex) return;
    try {
      computeSemanticRelationships(ctx.db, workspaceId, [cardId]);
    } catch (e) {
      console.warn("[embeddings] semantic recompute skipped:", e instanceof Error ? e.message : e);
    }
  }).catch(() => { /* already warned */ });
}
