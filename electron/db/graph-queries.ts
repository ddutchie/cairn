/**
 * Cairn — Knowledge Graph query helpers
 *
 * Assembles a workspace-level graph from all relationship sources:
 *   - Hard FK: project membership (notes, cards → project)
 *   - JSON arrays: note↔note, note↔card links
 *   - JSON arrays: tag membership on notes + cards
 *   - IdeaFlow: note_ref / task_ref nodes (soft refs)
 *   - IdeaFlow: explicit directional edges
 *   - relationship_cache: auto-discovered (co-mention, keyword, assignee)
 *
 * Nodes: project | note | card | tag
 * Edges carry { type, label, weight? }
 */

import type Database from "better-sqlite3";
import { getAllEmbeddingsForWorkspace, getAllTaskEmbeddingsForWorkspace } from "./queries";
import type { NoteEmbeddingRecord, TaskEmbeddingRecord } from "./queries";
import { cosine, toFloat32 } from "../embeddings/cosine";
import { stripMarkdown } from "../host-shared/text-utils";

// ── Public types ──────────────────────────────────────────────────────────────

export type GraphNodeType = "project" | "note" | "card" | "tag";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  title: string;
  projectId?: string;
  workspaceId: string;
  /** Extra metadata for the detail panel */
  meta?: {
    status?: string;
    priority?: string;
    assignee?: string;
    tagIds?: string[];
    isPinned?: boolean;
    snippet?: string;
    color?: string; // for tags
    isArchived?: boolean;
  };
}

export type EdgeType =
  | "note-note"
  | "note-card"
  | "tag-member"
  | "project-member"
  | "flow-ref"
  | "flow-edge"
  | "co-mention"
  | "keyword"
  | "assignee"
  | "wikilink"
  | "semantic";

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  label?: string;
  weight?: number;
  sourceSectionTitle?: string;
  targetSectionTitle?: string;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphFilters {
  projectIds?: string[];   // empty = all projects
  includeAuto?: boolean;   // include relationship_cache edges
  nodeTypes?: GraphNodeType[];
  edgeTypes?: EdgeType[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseJson(v: string | null | undefined): string[] {
  if (!v) return [];
  try { return JSON.parse(v) as string[]; } catch { return []; }
}

let _edgeSeq = 0;
function edgeId(type: string, src: string, tgt: string): string {
  return `${type}:${src}:${tgt}:${_edgeSeq++}`;
}

// ── Main query ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export function getKnowledgeGraph(
  db: Database.Database,
  workspaceId: string,
  filters: GraphFilters = {}
): KnowledgeGraph {
  _edgeSeq = 0;

  const {
    projectIds,
    includeAuto = true,
    nodeTypes,
    edgeTypes,
  } = filters;

  const wantsType = (t: GraphNodeType) => !nodeTypes || nodeTypes.includes(t);
  const wantsEdge = (t: EdgeType) => !edgeTypes || edgeTypes.includes(t);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeSet = new Set<string>(); // dedup

  function addNode(n: GraphNode) {
    if (nodeSet.has(n.id)) return;
    nodeSet.add(n.id);
    nodes.push(n);
  }

  // ── Project filter clause ──────────────────────────────────────────────────
  const projFilter = projectIds && projectIds.length > 0
    ? `AND id IN (${projectIds.map(() => "?").join(",")})`
    : "";
  const projArgs = projectIds && projectIds.length > 0 ? projectIds : [];

  // ── 1. Projects ────────────────────────────────────────────────────────────
  if (wantsType("project")) {
    const projects = db.prepare(
      `SELECT id, name, description, status, priority, workspace_id
       FROM projects
       WHERE workspace_id = ? AND archived_at IS NULL ${projFilter}`
    ).all(workspaceId, ...projArgs) as Row[];

    for (const p of projects) {
      addNode({
        id: p.id,
        type: "project",
        title: p.name as string,
        workspaceId: p.workspace_id as string,
        meta: { status: p.status, priority: p.priority },
      });
    }
  }

  // ── Build project id set for scoping child queries ────────────────────────
  const scopedProjects = db.prepare(
    `SELECT id FROM projects WHERE workspace_id = ? AND archived_at IS NULL ${projFilter}`
  ).all(workspaceId, ...projArgs) as Row[];
  const scopedProjectIds = new Set(scopedProjects.map((r) => r.id as string));
  if (scopedProjectIds.size === 0) return { nodes, edges };

  const projPlaceholders = [...scopedProjectIds].map(() => "?").join(",");
  const projIdArgs = [...scopedProjectIds];

  // ── 2. Notes ───────────────────────────────────────────────────────────────
  // Exclude soft-deleted notes (deleted_at tombstone) — otherwise a deleted
  // note keeps showing up in the Knowledge Graph until a full recompute.
  const notes = db.prepare(
    `SELECT id, project_id, workspace_id, title, content, tag_ids,
            linked_note_ids, linked_card_ids, is_pinned
     FROM notes
     WHERE project_id IN (${projPlaceholders}) AND archived_at IS NULL AND deleted_at IS NULL`
  ).all(...projIdArgs) as Row[];

  const noteMap = new Map<string, Row>();
  // Live-note id set, built up front: explicit links are only emitted when
  // BOTH endpoints are live, so a surviving note can't drag a soft-deleted
  // (tombstoned) note back into the graph as an edge endpoint. (noteMap is
  // still populated incrementally below; the set covers forward references.)
  const liveNoteIds = new Set(notes.map((n) => n.id as string));
  for (const n of notes) {
    noteMap.set(n.id as string, n);
    if (wantsType("note")) {
      addNode({
        id: n.id,
        type: "note",
        title: n.title as string,
        projectId: n.project_id as string,
        workspaceId: n.workspace_id as string,
        meta: {
          tagIds: parseJson(n.tag_ids),
          isPinned: n.is_pinned === 1,
          snippet: stripMarkdown(n.content as string || "").slice(0, 600),
        },
      });
    }

    // project-member edge
    if (wantsEdge("project-member") && wantsType("note")) {
      edges.push({
        id: edgeId("project-member", n.project_id, n.id),
        source: n.project_id as string,
        target: n.id as string,
        type: "project-member",
        label: "belongs to",
      });
    }

    // note-note links
    if (wantsEdge("note-note") && wantsType("note")) {
      for (const linkedId of parseJson(n.linked_note_ids)) {
        // Only add once (lower id is source to avoid duplicates), and only
        // when the referenced note is live — a link to a tombstoned note
        // must not resurrect it as an edge endpoint.
        if ((n.id as string) < linkedId && liveNoteIds.has(linkedId)) {
          edges.push({
            id: edgeId("note-note", n.id, linkedId),
            source: n.id as string,
            target: linkedId,
            type: "note-note",
            label: "linked",
          });
        }
      }
    }
  }

  // ── 3. Cards ───────────────────────────────────────────────────────────────
  // Exclude soft-deleted cards (deleted_at tombstone). Archived cards stay
  // visible (flagged via meta.isArchived) — matching the board behaviour.
  const cards = db.prepare(
    `SELECT id, project_id, workspace_id, title, description, tag_ids,
            linked_note_ids, priority, assignee, archived_at
     FROM task_cards
     WHERE project_id IN (${projPlaceholders}) AND deleted_at IS NULL`
  ).all(...projIdArgs) as Row[];

  const cardMap = new Map<string, Row>();
  for (const c of cards) {
    cardMap.set(c.id as string, c);
    if (wantsType("card")) {
      addNode({
        id: c.id,
        type: "card",
        title: c.title as string,
        projectId: c.project_id as string,
        workspaceId: c.workspace_id as string,
        meta: {
          priority: c.priority,
          assignee: c.assignee,
          tagIds: parseJson(c.tag_ids),
          snippet: (c.description as string || "").slice(0, 600),
          isArchived: !!(c.archived_at),
        },
      });
    }

    // project-member edge
    if (wantsEdge("project-member") && wantsType("card")) {
      edges.push({
        id: edgeId("project-member", c.project_id, c.id),
        source: c.project_id as string,
        target: c.id as string,
        type: "project-member",
        label: "belongs to",
      });
    }

    // note-card links (only when the referenced note is live — a card
    // linking a tombstoned note must not resurrect it as an edge endpoint)
    if (wantsEdge("note-card") && wantsType("note") && wantsType("card")) {
      for (const noteId of parseJson(c.linked_note_ids)) {
        if (!noteMap.has(noteId)) continue;
        edges.push({
          id: edgeId("note-card", noteId, c.id),
          source: noteId,
          target: c.id as string,
          type: "note-card",
          label: "linked",
        });
      }
    }
  }

  // ── 4. Tags ────────────────────────────────────────────────────────────────
  const tags = db.prepare(
    "SELECT id, name, color, workspace_id FROM tags WHERE workspace_id = ?"
  ).all(workspaceId) as Row[];

  const tagMap = new Map<string, Row>();
  for (const t of tags) tagMap.set(t.id as string, t);

  if (wantsType("tag") && wantsEdge("tag-member")) {
    // Collect which tags are actually referenced in scoped notes/cards
    // Invert tag_ids once (tag → tagged notes, then cards) instead of
    // re-parsing every row's JSON for every tag — that was
    // O(tags × (notes + cards)) JSON.parse calls on large workspaces.
    const membersByTag = new Map<string, { notes: string[]; cards: string[] }>();
    const membersOf = (tid: string) => {
      let m = membersByTag.get(tid);
      if (!m) membersByTag.set(tid, (m = { notes: [], cards: [] }));
      return m;
    };
    for (const n of notes) for (const tid of new Set(parseJson(n.tag_ids))) membersOf(tid).notes.push(n.id as string);
    for (const c of cards) for (const tid of new Set(parseJson(c.tag_ids))) membersOf(tid).cards.push(c.id as string);

    for (const [tagId, members] of membersByTag) {
      const t = tagMap.get(tagId);
      if (!t) continue;
      addNode({
        id: tagId,
        type: "tag",
        title: t.name as string,
        workspaceId: t.workspace_id as string,
        meta: { color: t.color },
      });

      // edges from tagged items → tag (notes first, then cards — same order
      // as before, so edge ids stay stable)
      for (const id of [...members.notes, ...members.cards]) {
        edges.push({
          id: edgeId("tag-member", id, tagId),
          source: id,
          target: tagId,
          type: "tag-member",
          label: "tagged",
        });
      }
    }
  }

  // ── 5. IdeaFlow edges ──────────────────────────────────────────────────────
  // (flow-ref: note_ref / task_ref nodes only restate membership that the
  // project-member edges already capture, so they add no edges. The loop that
  // used to read + JSON-parse every note_ref node per flow did nothing with the
  // result and has been removed.)
  if (wantsEdge("flow-edge")) {
    const flows = db.prepare(
      `SELECT id FROM idea_flows WHERE project_id IN (${projPlaceholders})`
    ).all(...projIdArgs) as Row[];

    // Explicit user-drawn edges between note_ref / task_ref nodes. Prepared
    // once and re-run per flow.
    const flowEdgesStmt = db.prepare(
      `SELECT fe.id, sn.type as stype, sn.data as sdata,
              tn.type as ttype, tn.data as tdata, fe.label
       FROM idea_flow_edges fe
       JOIN idea_flow_nodes sn ON sn.id = fe.source_node_id
       JOIN idea_flow_nodes tn ON tn.id = fe.target_node_id
       WHERE fe.flow_id = ?`
    );
    for (const flow of flows) {
      const flowEdges = flowEdgesStmt.all(flow.id as string) as Row[];
      for (const fe of flowEdges) {
        const sdata = JSON.parse((fe.sdata as string) || "{}") as Record<string, string>;
        const tdata = JSON.parse((fe.tdata as string) || "{}") as Record<string, string>;
        const srcId = sdata.noteId || sdata.cardId;
        const tgtId = tdata.noteId || tdata.cardId;
        if (srcId && tgtId && nodeSet.has(srcId) && nodeSet.has(tgtId)) {
          edges.push({
            id: edgeId("flow-edge", srcId, tgtId),
            source: srcId,
            target: tgtId,
            type: "flow-edge",
            label: (fe.label as string) || "connected",
          });
        }
      }
    }
  }

  // ── 6. Auto relationships (relationship_cache) ─────────────────────────────
  if (includeAuto && (wantsEdge("co-mention") || wantsEdge("keyword") || wantsEdge("assignee") || wantsEdge("wikilink") || wantsEdge("semantic"))) {
    const autoTypes: string[] = [];
    if (wantsEdge("co-mention")) autoTypes.push("co-mention");
    if (wantsEdge("keyword"))    autoTypes.push("keyword");
    if (wantsEdge("assignee"))   autoTypes.push("assignee");
    if (wantsEdge("wikilink"))   autoTypes.push("wikilink");
    if (wantsEdge("semantic"))   autoTypes.push("semantic");

    if (autoTypes.length > 0) {
      const typePlaceholders = autoTypes.map(() => "?").join(",");
      // Scope in SQL: relationship_cache spans every workspace and project, so
      // reading it whole and filtering in JS cost O(all cached pairs) per load
      // even with a single project selected. The source_id IN (json_each) probe
      // uses the (source_id, target_id, type) primary key. The unary `+` on
      // target_id keeps that term out of the index key: without it the
      // planner probes the key with every (source, target) pair — O(nodes²),
      // ~12s at 5k notes (see bench/graph.bench.ts). With it, the target list
      // is a bloom-filtered membership check on the rows the source probe finds.
      const scopedIds = JSON.stringify([...nodeSet]);
      const cacheRows = db.prepare(
        `SELECT source_id, target_id, type, weight, source_section_title, target_section_title
         FROM relationship_cache
         WHERE type IN (${typePlaceholders})
           AND source_id IN (SELECT value FROM json_each(?))
           AND +target_id IN (SELECT value FROM json_each(?))`
      ).all(...autoTypes, scopedIds, scopedIds) as Row[];

      for (const r of cacheRows) {
        const src = r.source_id as string;
        const tgt = r.target_id as string;
        if (nodeSet.has(src) && nodeSet.has(tgt)) {
          edges.push({
            id: edgeId(r.type as string, src, tgt),
            source: src,
            target: tgt,
            type: r.type as EdgeType,
            weight: r.weight as number,
            label: r.type as string,
            sourceSectionTitle: (r.source_section_title as string | null) ?? undefined,
            targetSectionTitle: (r.target_section_title as string | null) ?? undefined,
          });
        }
      }
    }
  }

  return { nodes, edges };
}

// ── Neighbour traversal ───────────────────────────────────────────────────────

export interface NeighbourNode {
  node: GraphNode;
  edge: GraphEdge;
  distance: number;
}

export interface NeighboursResult {
  center: GraphNode | null;
  neighbours: NeighbourNode[];
}

export function getNeighbours(
  db: Database.Database,
  workspaceId: string,
  nodeId: string,
  depth: number = 1,
  edgeTypes?: EdgeType[]
): NeighboursResult {
  // Determine relevant projects for the center node to avoid loading the entire workspace
  let projectIds: string[] | undefined = undefined;

  const isProject = db.prepare("SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL").get(nodeId);
  if (isProject) {
    projectIds = [nodeId];
  } else {
    const noteRow = db.prepare("SELECT project_id FROM notes WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL").get(nodeId) as { project_id: string } | undefined;
    if (noteRow) {
      projectIds = [noteRow.project_id];
    } else {
      const cardRow = db.prepare("SELECT project_id FROM task_cards WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL").get(nodeId) as { project_id: string } | undefined;
      if (cardRow) {
        projectIds = [cardRow.project_id];
      } else {
        // Tag ID: find projects containing notes or cards tagged with it
        const tagProj = new Set<string>();
        const taggedNotes = db.prepare("SELECT DISTINCT project_id FROM notes WHERE tag_ids LIKE ? AND archived_at IS NULL AND deleted_at IS NULL").all(`%"${nodeId}"%`) as { project_id: string }[];
        for (const n of taggedNotes) tagProj.add(n.project_id);
        const taggedCards = db.prepare("SELECT DISTINCT project_id FROM task_cards WHERE tag_ids LIKE ? AND archived_at IS NULL AND deleted_at IS NULL").all(`%"${nodeId}"%`) as { project_id: string }[];
        for (const c of taggedCards) tagProj.add(c.project_id);
        if (tagProj.size > 0) {
          projectIds = Array.from(tagProj);
        }
      }
    }
  }

  // Build project-scoped graph then BFS
  const graph = getKnowledgeGraph(db, workspaceId, {
    includeAuto: true,
    edgeTypes,
    projectIds,
  });

  const center = graph.nodes.find((n) => n.id === nodeId) ?? null;
  if (!center) return { center: null, neighbours: [] };

  // Build adjacency map
  const adj = new Map<string, { nodeId: string; edge: GraphEdge }[]>();
  for (const e of graph.edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source)!.push({ nodeId: e.target, edge: e });
    adj.get(e.target)!.push({ nodeId: e.source, edge: e });
  }

  // BFS
  const visited = new Set<string>([nodeId]);
  const queue: { id: string; dist: number; edge: GraphEdge }[] = [];
  const neighbours: NeighbourNode[] = [];

  for (const adj_ of adj.get(nodeId) ?? []) {
    if (!visited.has(adj_.nodeId)) {
      visited.add(adj_.nodeId);
      queue.push({ id: adj_.nodeId, dist: 1, edge: adj_.edge });
    }
  }

  while (queue.length > 0) {
    const item = queue.shift()!;
    const node = graph.nodes.find((n) => n.id === item.id);
    if (!node) continue;
    neighbours.push({ node, edge: item.edge, distance: item.dist });

    if (item.dist < depth) {
      for (const adj_ of adj.get(item.id) ?? []) {
        if (!visited.has(adj_.nodeId)) {
          visited.add(adj_.nodeId);
          queue.push({ id: adj_.nodeId, dist: item.dist + 1, edge: adj_.edge });
        }
      }
    }
  }

  return { center, neighbours };
}

// ── Auto-relationship computation ─────────────────────────────────────────────
// Lives in auto-relationships.ts; re-exported so existing imports keep working.
export { computeAutoRelationships } from "./auto-relationships";

/** Invalidate relationship_cache rows for a specific entity */
export function invalidateRelationshipCache(
  db: Database.Database,
  entityId: string
): void {
  db.prepare(
    "DELETE FROM relationship_cache WHERE source_id = ? OR target_id = ?"
  ).run(entityId, entityId);
}

const SEMANTIC_TOP_K = 5;
const SEMANTIC_TOP_K_FLOOR = 0.60;
/**
 * Recompute embedding-based semantic edges by cosine-similarity between the
 * stored `search_document` vectors for this workspace. Since v18, vectors are
 * per-section, so one note can have multiple embedding rows. This function
 * compares all sections across all notes, finds the top-K most-similar
 * *sections* for each active section, then maps those back to note-pair edges
 * (keeping the best weight per note pair). Output goes to `relationship_cache`
 * under the `"semantic"` type so the existing pass-6 loader picks it up.
 *
 * Strategy: top-K nearest sections per active section, cosine >= floor 0.55.
 * Edges are between notes (not sections) — the best section-pair weight wins.
 * Canonical source<target ordering ensures (a,b) and (b,a) collapse to one row.
 *
 * Incremental mode: when `entityIds` is non-empty, only sections belonging to
 * the active note set are used as query sources; the full pool is still used
 * as candidates so an edited note can discover new connections.
 */
export function computeSemanticRelationships(
  db: Database.Database,
  workspaceId: string,
  entityIds?: string[]
): void {
  // Pool BOTH note sections and task-card sections so semantic edges can form
  // across kinds: note↔note, task↔task, and note↔task. All are stored as a
  // single "semantic" edge type keyed by entity id — getKnowledgeGraph pass 6
  // only checks that both endpoints exist as nodes (card nodes already do), so
  // no per-kind handling is needed downstream.
  const storedNotes = getAllEmbeddingsForWorkspace(db, workspaceId, "search_document");
  const storedCards = getAllTaskEmbeddingsForWorkspace(db, workspaceId, "search_document");
  if (storedNotes.length + storedCards.length === 0) return;

  interface SectionVec {
    entityId: string;
    sectionIdx: number;
    sectionTitle: string;
    vec: Float32Array;
  }
  const fullPool: SectionVec[] = [
    ...storedNotes.map((r: NoteEmbeddingRecord) => ({
      entityId: r.noteId,
      sectionIdx: r.sectionIdx,
      sectionTitle: r.sectionTitle,
      vec: toFloat32(r.vector),
    })),
    ...storedCards.map((r: TaskEmbeddingRecord) => ({
      entityId: r.cardId,
      sectionIdx: r.sectionIdx,
      sectionTitle: r.sectionTitle,
      vec: toFloat32(r.vector),
    })),
  ];

  const entityIdsInPool = new Set(fullPool.map((s) => s.entityId));
  if (entityIdsInPool.size < 2) return;

  let activePool: SectionVec[] = fullPool;
  let activeIds: Set<string> | null = null;
  if (entityIds && entityIds.length > 0) {
    activeIds = new Set(entityIds);
    activePool = fullPool.filter((s) => activeIds!.has(s.entityId));
  }

  const k = Math.min(SEMANTIC_TOP_K, Math.max(1, entityIdsInPool.size - 1));

  const now = Math.floor(Date.now() / 1000);
  const upsert = db.prepare(`
    INSERT INTO relationship_cache (source_id, target_id, type, weight, computed_at, source_section_title, target_section_title)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, target_id, type) DO UPDATE SET
      weight = excluded.weight,
      computed_at = excluded.computed_at,
      source_section_title = excluded.source_section_title,
      target_section_title = excluded.target_section_title
  `);
  const deleteOld = db.prepare(`
    DELETE FROM relationship_cache WHERE (source_id = ? OR target_id = ?) AND type = 'semantic'
  `);

  const tx = db.transaction(() => {
    if (activeIds) {
      for (const id of activeIds) deleteOld.run(id, id);
    } else {
      for (const id of entityIdsInPool) deleteOld.run(id, id);
    }

    const bestPerPair = new Map<string, { weight: number; sourceTitle: string; targetTitle: string }>();

    for (const a of activePool) {
      const scored: Array<{ sec: SectionVec; sim: number }> = [];
      for (const b of fullPool) {
        if (a.entityId === b.entityId) continue;
        const sim = cosine(a.vec, b.vec);
        if (sim >= SEMANTIC_TOP_K_FLOOR) {
          scored.push({ sec: b, sim });
        }
      }
      scored.sort((x, y) => y.sim - x.sim);
      const top = scored.slice(0, k);
      for (const t of top) {
        const [srcId, tgtId, srcSec, tgtSec] =
          a.entityId < t.sec.entityId
            ? [a.entityId, t.sec.entityId, a.sectionTitle, t.sec.sectionTitle]
            : [t.sec.entityId, a.entityId, t.sec.sectionTitle, a.sectionTitle];
        const key = `${srcId}|${tgtId}`;
        const ex = bestPerPair.get(key);
        if (!ex || t.sim > ex.weight) {
          bestPerPair.set(key, { weight: t.sim, sourceTitle: srcSec, targetTitle: tgtSec });
        }
      }
    }

    for (const [key, val] of bestPerPair) {
      const [src, tgt] = key.split("|");
      upsert.run(src, tgt, "semantic", Math.round(val.weight * 100) / 100, now, val.sourceTitle, val.targetTitle);
    }
  });
  tx();
}

export interface SemanticNeighbor {
  noteId: string;
  title: string;
  weight: number;
  sourceSectionTitle: string | null;
  targetSectionTitle: string | null;
}

export function getSemanticNeighbors(
  db: Database.Database,
  noteId: string,
  workspaceId?: string,
): SemanticNeighbor[] {
  const wsClause = workspaceId ? `AND n.workspace_id = ?` : "";
  const wsParams = workspaceId ? [workspaceId, workspaceId] : [];
  const rows = db.prepare(`
    SELECT
      rc.source_id, rc.target_id, rc.weight,
      rc.source_section_title, rc.target_section_title,
      CASE WHEN rc.source_id = ? THEN rc.target_id ELSE rc.source_id END AS other_id,
      CASE WHEN rc.source_id = ? THEN rc.source_section_title ELSE rc.target_section_title END AS this_section,
      CASE WHEN rc.source_id = ? THEN rc.target_section_title ELSE rc.source_section_title END AS other_section
    FROM relationship_cache rc
    WHERE rc.type = 'semantic'
      AND (rc.source_id = ? OR rc.target_id = ?)
    ORDER BY rc.weight DESC
  `).all(
    noteId, noteId, noteId, noteId, noteId,
  ) as Array<{
    other_id: string;
    weight: number;
    this_section: string | null;
    other_section: string | null;
  }>;

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.other_id);
  const placeholders = ids.map(() => "?").join(",");
  const titleRows = db.prepare(
    `SELECT n.id, n.title FROM notes n WHERE n.id IN (${placeholders}) AND n.deleted_at IS NULL AND n.archived_at IS NULL ${wsClause}`,
  ).all(...ids, ...wsParams) as Array<{ id: string; title: string }>;
  const titleMap = new Map(titleRows.map((r) => [r.id, r.title] as const));

  return rows
    .filter((r) => titleMap.has(r.other_id))
    .map((r) => ({
      noteId: r.other_id,
      title: titleMap.get(r.other_id) ?? r.other_id,
      weight: r.weight,
      sourceSectionTitle: r.this_section,
      targetSectionTitle: r.other_section,
    }));
}
