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
  | "wikilink";

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  label?: string;
  weight?: number; // 0–1 for auto edges
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
  const notes = db.prepare(
    `SELECT id, project_id, workspace_id, title, content_text, tag_ids,
            linked_note_ids, linked_card_ids, is_pinned
     FROM notes
     WHERE project_id IN (${projPlaceholders}) AND archived_at IS NULL`
  ).all(...projIdArgs) as Row[];

  const noteMap = new Map<string, Row>();
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
          snippet: (n.content_text as string || "").slice(0, 120),
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
        // Only add once (lower id is source to avoid duplicates)
        if ((n.id as string) < linkedId) {
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
  const cards = db.prepare(
    `SELECT id, project_id, workspace_id, title, description, tag_ids,
            linked_note_ids, priority, assignee, archived_at
     FROM task_cards
     WHERE project_id IN (${projPlaceholders})`
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
          snippet: (c.description as string || "").slice(0, 120),
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

    // note-card links
    if (wantsEdge("note-card") && wantsType("note") && wantsType("card")) {
      for (const noteId of parseJson(c.linked_note_ids)) {
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
    const usedTagIds = new Set<string>();
    for (const n of notes) for (const tid of parseJson(n.tag_ids)) usedTagIds.add(tid);
    for (const c of cards) for (const tid of parseJson(c.tag_ids)) usedTagIds.add(tid);

    for (const tagId of usedTagIds) {
      const t = tagMap.get(tagId);
      if (!t) continue;
      addNode({
        id: tagId,
        type: "tag",
        title: t.name as string,
        workspaceId: t.workspace_id as string,
        meta: { color: t.color },
      });

      // edges from tagged items → tag
      for (const n of notes) {
        if (parseJson(n.tag_ids).includes(tagId)) {
          edges.push({
            id: edgeId("tag-member", n.id, tagId),
            source: n.id as string,
            target: tagId,
            type: "tag-member",
            label: "tagged",
          });
        }
      }
      for (const c of cards) {
        if (parseJson(c.tag_ids).includes(tagId)) {
          edges.push({
            id: edgeId("tag-member", c.id, tagId),
            source: c.id as string,
            target: tagId,
            type: "tag-member",
            label: "tagged",
          });
        }
      }
    }
  }

  // ── 5. IdeaFlow refs + edges ───────────────────────────────────────────────
  if (wantsEdge("flow-ref") || wantsEdge("flow-edge")) {
    const flows = db.prepare(
      `SELECT id FROM idea_flows WHERE project_id IN (${projPlaceholders})`
    ).all(...projIdArgs) as Row[];

    for (const flow of flows) {
      const flowId = flow.id as string;

      if (wantsEdge("flow-ref")) {
        // note_ref nodes pointing to notes
        const noteRefs = db.prepare(
          `SELECT data FROM idea_flow_nodes WHERE flow_id = ? AND type = 'note_ref'`
        ).all(flowId) as Row[];
        for (const nr of noteRefs) {
          const data = JSON.parse(nr.data as string || "{}") as Record<string, string>;
          if (data.noteId && nodeSet.has(data.noteId)) {
            // flow references create a self-referential "mentioned in flow" concept,
            // represented as an edge from the project to the note already exists;
            // here we skip to avoid noise — the note is already in the graph.
          }
        }

        // task_ref nodes pointing to cards
        // (same rationale — already captured via project-member)
      }

      if (wantsEdge("flow-edge")) {
        // Explicit user-drawn edges between note_ref / task_ref nodes
        const flowEdges = db.prepare(
          `SELECT fe.id, sn.type as stype, sn.data as sdata,
                  tn.type as ttype, tn.data as tdata, fe.label
           FROM idea_flow_edges fe
           JOIN idea_flow_nodes sn ON sn.id = fe.source_node_id
           JOIN idea_flow_nodes tn ON tn.id = fe.target_node_id
           WHERE fe.flow_id = ?`
        ).all(flowId) as Row[];

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
  }

  // ── 6. Auto relationships (relationship_cache) ─────────────────────────────
  if (includeAuto && (wantsEdge("co-mention") || wantsEdge("keyword") || wantsEdge("assignee") || wantsEdge("wikilink"))) {
    const autoTypes: string[] = [];
    if (wantsEdge("co-mention")) autoTypes.push("co-mention");
    if (wantsEdge("keyword"))    autoTypes.push("keyword");
    if (wantsEdge("assignee"))   autoTypes.push("assignee");
    if (wantsEdge("wikilink"))   autoTypes.push("wikilink");

    if (autoTypes.length > 0) {
      const typePlaceholders = autoTypes.map(() => "?").join(",");
      const cacheRows = db.prepare(
        `SELECT source_id, target_id, type, weight
         FROM relationship_cache
         WHERE type IN (${typePlaceholders})`
      ).all(...autoTypes) as Row[];

      for (const r of cacheRows) {
        const src = r.source_id as string;
        const tgt = r.target_id as string;
        // Only include if both endpoints are in the current graph scope
        if (nodeSet.has(src) && nodeSet.has(tgt)) {
          edges.push({
            id: edgeId(r.type as string, src, tgt),
            source: src,
            target: tgt,
            type: r.type as EdgeType,
            weight: r.weight as number,
            label: r.type as string,
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
    const noteRow = db.prepare("SELECT project_id FROM notes WHERE id = ? AND archived_at IS NULL").get(nodeId) as { project_id: string } | undefined;
    if (noteRow) {
      projectIds = [noteRow.project_id];
    } else {
      const cardRow = db.prepare("SELECT project_id FROM task_cards WHERE id = ? AND archived_at IS NULL").get(nodeId) as { project_id: string } | undefined;
      if (cardRow) {
        projectIds = [cardRow.project_id];
      } else {
        // Tag ID: find projects containing notes or cards tagged with it
        const tagProj = new Set<string>();
        const taggedNotes = db.prepare("SELECT DISTINCT project_id FROM notes WHERE tag_ids LIKE ? AND archived_at IS NULL").all(`%"${nodeId}"%`) as { project_id: string }[];
        for (const n of taggedNotes) tagProj.add(n.project_id);
        const taggedCards = db.prepare("SELECT DISTINCT project_id FROM task_cards WHERE tag_ids LIKE ? AND archived_at IS NULL").all(`%"${nodeId}"%`) as { project_id: string }[];
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

/** Extract [[Title]] wikilink targets from markdown content */
function extractWikilinkTitles(content: string): string[] {
  const results: string[] = [];
  const re = /\[\[([^\][\n]+?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const title = m[1].trim();
    if (title.length > 0) results.push(title.toLowerCase());
  }
  return results;
}

/** Tokenise text into lowercase words, filter stop-words, min length 4 */
function tokenise(text: string): string[] {
  const STOP = new Set([
    "this","that","with","from","have","will","been","they","them","then",
    "when","what","which","into","over","your","more","also","some","just",
    "than","about","would","there","their","these","those",
  ]);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 5 && !STOP.has(w));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function computeAutoRelationships(
  db: Database.Database,
  workspaceId: string,
  entityIds?: string[]
): void {
  const now = Math.floor(Date.now() / 1000);

  // Load all non-archived notes + cards for this workspace
  const allNotes = db.prepare(
    `SELECT id, title, content_text FROM notes
     WHERE workspace_id = ? AND archived_at IS NULL`
  ).all(workspaceId) as Row[];

  const allCards = db.prepare(
    `SELECT id, title, description, assignee FROM task_cards
     WHERE workspace_id = ? AND archived_at IS NULL`
  ).all(workspaceId) as Row[];

  const upsert = db.prepare(`
    INSERT INTO relationship_cache (source_id, target_id, type, weight, computed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_id, target_id, type) DO UPDATE SET
      weight = excluded.weight,
      computed_at = excluded.computed_at
  `);

  const deleteOld = db.prepare(`
    DELETE FROM relationship_cache
    WHERE source_id = ? OR target_id = ?
  `);

  // ── Incremental mode: filter to only entities that need recomputing ────────
  // An entity needs recomputing if:
  //   (a) it is in the entityIds set (directly changed), OR
  //   (b) its content/title mentions one of the changed entities
  //       (so incoming co-mention edges are also refreshed)
  let notes: Row[];
  let cards: Row[];

  if (entityIds && entityIds.length > 0) {
    const idSet = new Set(entityIds);

    // Build a set of lowercase titles for the changed entities so we can
    // detect which other notes/cards mention them.
    const changedTitles = new Set<string>();
    for (const n of allNotes) {
      if (idSet.has(n.id as string)) changedTitles.add((n.title as string).toLowerCase());
    }
    for (const c of allCards) {
      if (idSet.has(c.id as string)) changedTitles.add((c.title as string).toLowerCase());
    }

    notes = allNotes.filter((n) => {
      if (idSet.has(n.id as string)) return true;
      const text = ((n.content_text as string) || "").toLowerCase();
      for (const t of changedTitles) if (text.includes(t)) return true;
      return false;
    });

    cards = allCards.filter((c) => {
      if (idSet.has(c.id as string)) return true;
      const text = ((c.description as string) || "").toLowerCase();
      for (const t of changedTitles) if (text.includes(t)) return true;
      return false;
    });
  } else {
    notes = allNotes;
    cards = allCards;
  }

  const runAll = db.transaction(() => {
    // Clear stale cache for the entities being recomputed
    const allIds = [...notes.map((n) => n.id as string), ...cards.map((c) => c.id as string)];
    for (const id of allIds) deleteOld.run(id, id);

    // ── Wikilink: [[Title]] explicit author-written links ─────────────────
    const noteTitleToId = new Map<string, string>(); // title_lower → noteId
    for (const n of allNotes) noteTitleToId.set((n.title as string).toLowerCase(), n.id as string);

    for (const n of notes) {
      const content = (n.content_text as string) || "";
      const targets = extractWikilinkTitles(content);
      for (const titleLower of targets) {
        const targetId = noteTitleToId.get(titleLower);
        if (!targetId || targetId === (n.id as string)) continue;
        const [src, tgt] = (n.id as string) < targetId
          ? [n.id as string, targetId]
          : [targetId, n.id as string];
        upsert.run(src, tgt, "wikilink", 1.0, now);
      }
    }

    // ── Co-mention: note content mentions another note/card title ─────────
    const titleMap = new Map<string, string>(); // title_lower → id
    for (const n of allNotes) titleMap.set((n.title as string).toLowerCase(), n.id as string);
    for (const c of allCards) titleMap.set((c.title as string).toLowerCase(), c.id as string);

    for (const n of notes) {
      const text = ((n.content_text as string) || "").toLowerCase();
      for (const [title, targetId] of titleMap) {
        if (targetId === n.id) continue;
        if (title.length >= 5 && text.includes(title)) {
          const weight = Math.min(0.9, title.length / 20);
          const [src, tgt] = (n.id as string) < targetId ? [n.id as string, targetId] : [targetId, n.id as string];
          upsert.run(src, tgt, "co-mention", weight, now);
        }
      }
    }

    // ── Keyword similarity: TF-IDF Jaccard between notes ────────────────
    const noteTokens: { id: string; tokens: Set<string> }[] = notes.map((n) => ({
      id: n.id as string,
      tokens: new Set(tokenise(((n.title as string) || "") + " " + ((n.content_text as string) || ""))),
    }));

    // For incremental mode, also build tokens for all notes so we can compare
    // filtered notes against the full corpus.
    const allNoteTokens: { id: string; tokens: Set<string> }[] = (entityIds && entityIds.length > 0)
      ? allNotes.map((n) => ({
          id: n.id as string,
          tokens: new Set(tokenise(((n.title as string) || "") + " " + ((n.content_text as string) || ""))),
        }))
      : noteTokens;

    const filteredIds = new Set(noteTokens.map((t) => t.id));
    const KEYWORD_THRESHOLD = 0.15;

    for (const a of noteTokens) {
      for (const b of allNoteTokens) {
        if (a.id >= b.id) continue; // canonical ordering, avoid duplicates
        if (!filteredIds.has(a.id) && !filteredIds.has(b.id)) continue;
        const sim = jaccardSimilarity(a.tokens, b.tokens);
        if (sim >= KEYWORD_THRESHOLD) {
          upsert.run(a.id, b.id, "keyword", Math.round(sim * 100) / 100, now);
        }
      }
    }

    // ── Same assignee: cards sharing an assignee ──────────────────────
    const byAssignee = new Map<string, string[]>();
    for (const c of allCards) {
      if (!c.assignee) continue;
      const key = (c.assignee as string).toLowerCase().trim();
      if (!byAssignee.has(key)) byAssignee.set(key, []);
      byAssignee.get(key)!.push(c.id as string);
    }

    const filteredCardIds = new Set(cards.map((c) => c.id as string));
    for (const [, ids] of byAssignee) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          // Only emit if at least one card is in the filtered set
          if (!filteredCardIds.has(ids[i]) && !filteredCardIds.has(ids[j])) continue;
          upsert.run(ids[i], ids[j], "assignee", 1.0, now);
        }
      }
    }
  });

  runAll();
}

/** Invalidate relationship_cache rows for a specific entity */
export function invalidateRelationshipCache(
  db: Database.Database,
  entityId: string
): void {
  db.prepare(
    "DELETE FROM relationship_cache WHERE source_id = ? OR target_id = ?"
  ).run(entityId, entityId);
}
