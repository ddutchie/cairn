/**
 * Knowledge-graph builder — a leaf query pulled out of queries.ts. Re-exported
 * from queries.ts so `@/db/queries` imports are unchanged. Kept import-cycle
 * free: it depends only on getDb, the shared SQL fragments, the pure parseIds
 * helper, and the graph/row types — never back on queries.ts.
 */

import { getDb } from "./index";
import { LIVE, NOT_CONFLICT } from "./sql";
import { parseIds } from "./row-helpers";
import type { GraphNode, GraphEdge, KnowledgeGraph, TagRow } from "./types";

/**
 * Build the workspace knowledge graph from the SYNCABLE tables the mobile app
 * holds: projects, notes, cards and tags, wired by their explicit links
 * (project membership, note↔note wikilinks, note↔card links, tag membership).
 *
 * Unlike desktop this omits idea-flow edges — mobile has no idea_flow_* tables.
 * It also emits only STRUCTURAL edges here; semantic edges (note↔note, task↔task
 * and note↔task, derived from on-device embeddings) are computed separately by
 * semanticEdges() in src/notes/embeddings.ts and merged in the graph screen
 * behind an opt-in toggle. Only tags actually referenced by a scoped note/card
 * become nodes, matching the desktop's "used tags only" behaviour.
 */
export function getKnowledgeGraph(): KnowledgeGraph {
  const db = getDb();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();
  const add = (n: GraphNode) => {
    if (nodeIds.has(n.id)) return;
    nodeIds.add(n.id);
    nodes.push(n);
  };
  const projects = db.getAllSync<{ id: string; name: string }>(
    `SELECT id, name FROM projects WHERE ${LIVE}`,
  );
  for (const p of projects) add({ id: p.id, type: "project", title: p.name });

  const notes = db.getAllSync<{
    id: string;
    project_id: string;
    title: string;
    tag_ids: string;
    linked_note_ids: string;
  }>(
    `SELECT id, project_id, title, tag_ids, linked_note_ids FROM notes
     WHERE ${LIVE} AND type='note' AND ${NOT_CONFLICT}`,
  );
  for (const n of notes) {
    add({ id: n.id, type: "note", title: n.title || "Untitled", projectId: n.project_id });
    if (nodeIds.has(n.project_id)) edges.push({ source: n.project_id, target: n.id, type: "project-member" });
    // note↔note links: emit once (lower id as source) to avoid duplicate pairs.
    for (const linked of parseIds(n.linked_note_ids)) {
      if (n.id < linked) edges.push({ source: n.id, target: linked, type: "note-note" });
    }
  }

  const cards = db.getAllSync<{
    id: string;
    project_id: string;
    title: string;
    priority: string;
    tag_ids: string;
    linked_note_ids: string;
  }>(
    `SELECT id, project_id, title, priority, tag_ids, linked_note_ids FROM task_cards
     WHERE ${LIVE}`,
  );
  for (const c of cards) {
    add({ id: c.id, type: "card", title: c.title, priority: c.priority, projectId: c.project_id });
    if (nodeIds.has(c.project_id)) edges.push({ source: c.project_id, target: c.id, type: "project-member" });
    for (const noteId of parseIds(c.linked_note_ids)) {
      if (nodeIds.has(noteId)) edges.push({ source: noteId, target: c.id, type: "note-card" });
    }
  }

  // Only tags actually used by a scoped note/card become nodes.
  const usedTagIds = new Set<string>();
  for (const n of notes) for (const tid of parseIds(n.tag_ids)) usedTagIds.add(tid);
  for (const c of cards) for (const tid of parseIds(c.tag_ids)) usedTagIds.add(tid);
  if (usedTagIds.size > 0) {
    const ids = [...usedTagIds];
    const placeholders = ids.map(() => "?").join(",");
    const tagRows = db.getAllSync<TagRow>(
      `SELECT id, name, color FROM tags WHERE deleted_at IS NULL AND id IN (${placeholders})`,
      ...(ids as never[]),
    );
    const tagById = new Map(tagRows.map((tr) => [tr.id, tr]));
    for (const tid of usedTagIds) {
      const tag = tagById.get(tid);
      if (!tag) continue;
      add({ id: tag.id, type: "tag", title: tag.name, color: tag.color });
    }
    for (const n of notes) for (const tid of parseIds(n.tag_ids)) {
      if (nodeIds.has(tid)) edges.push({ source: n.id, target: tid, type: "tag-member" });
    }
    for (const c of cards) for (const tid of parseIds(c.tag_ids)) {
      if (nodeIds.has(tid)) edges.push({ source: c.id, target: tid, type: "tag-member" });
    }
  }

  return { nodes, edges };
}
