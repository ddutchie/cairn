/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from "better-sqlite3";
import {
  getKnowledgeGraph,
  getNeighbours,
  getSemanticNeighbors,
  type GraphFilters,
  type EdgeType,
  type GraphNode,
  type GraphEdge,
  type KnowledgeGraph,
  type NeighboursResult,
} from "../../db/graph-queries";
import { insertNotification } from "../db";

/**
 * Compact a `GraphNode` for the MCP return surface.
 *
 * Optimisations:
 *  - Drop `workspaceId` (every node in a workspace-scoped graph has the same value).
 *  - Flatten the `meta` object: project membership, tag ids, etc. get hoisted onto
 *    the node only when present. Empty `meta: {}` becomes nothing.
 *  - Never emit null/undefined fields.
 */
function compactNode(n: GraphNode): Record<string, unknown> {
  const out: Record<string, unknown> = { id: n.id, type: n.type, title: n.title };
  if (n.projectId) out.projectId = n.projectId;
  const m = n.meta;
  if (m) {
    if (m.status !== undefined) out.status = m.status;
    if (m.priority !== undefined) out.priority = m.priority;
    if (m.assignee) out.assignee = m.assignee;
    if (m.tagIds && m.tagIds.length > 0) out.tagIds = m.tagIds;
    if (m.isPinned) out.isPinned = m.isPinned;
    if (m.snippet) out.snippet = m.snippet;
    if (m.color) out.color = m.color;
    if (m.isArchived) out.isArchived = m.isArchived;
  }
  return out;
}

/**
 * Compact a `GraphEdge` for the MCP return surface.
 *
 * Optimisations:
 *  - Drop the synthetic `id` (built as `${type}:${src}:${tgt}:${seq}`) — agents
 *    identify edges by source+target+type.
 *  - Drop predictable labels: "belongs to" (project-member) and "tagged"
 *    (tag-member) are entirely derived from the edge type.
 *  - Omit empty `label` / `weight` / section titles.
 *
 * Stable order: s, t, type, label?, w?, sSec?, tSec?
 */
function compactEdge(e: GraphEdge): Record<string, unknown> {
  const out: Record<string, unknown> = { s: e.source, t: e.target, type: e.type };
  let label = e.label;
  if (e.type === "project-member") label = undefined; // always "belongs to"
  else if (e.type === "tag-member") label = undefined;  // always "tagged"
  if (label) out.label = label;
  if (e.weight !== undefined) out.w = e.weight;
  if (e.sourceSectionTitle) out.sSec = e.sourceSectionTitle;
  if (e.targetSectionTitle) out.tSec = e.targetSectionTitle;
  return out;
}

// Key order compactEdge emits (matches the order above).
const EDGE_FIELDS = ["s", "t", "label", "w", "sSec", "tSec"] as const;

// Key order compactNode emits, used for column-encoding (must match emit order).
// `type` is omitted because compactGraph partitions nodes by type — the block
// key in the output tells the consumer the type, so the per-row `type` cell
// would be redundant.
const NODE_FIELDS = ["id", "title", "projectId", "status", "priority",
                     "assignee", "tagIds", "isPinned", "snippet", "color", "isArchived"] as const;

/**
 * Column-encode an array of records into `{ fields, rows }` form
 * (à la Headroom's SmartCrusher). Saves every per-row key repetition plus
 * structural `{}`/`""` overhead.
 *
 * `fieldOrder` must list every key that could appear on a record, in emit
 * order. Records that omit a key get `null` in that column.
 *
 * Only worth it once `rows.length × fieldOrder.length` is large enough that
 * key-name repetition exceeds the header tax — call sites decide when to
 * invoke this (see `columnEncodeIfBig`).
 *
 * **Important optimisation**: any field that is absent from *every* record is
 * omitted from the header and never appears in any row. Combined with
 * type-partitioned blocks (see `compactGraph`), this means projects never
 * carry a `snippet` column, notes never carry a `color` column, etc.
 */
function columnEncode(
  records: Record<string, unknown>[],
  fieldOrder: readonly string[],
): { fields: string[]; rows: unknown[][] } {
  // Determine which fields actually appear on at least one record.
  const presentFields = fieldOrder.filter((f) =>
    records.some((r) => r[f] !== undefined && r[f] !== null),
  );
  const rows = records.map((r) =>
    presentFields.map((f) => (r[f] === undefined ? null : r[f])),
  );
  return { fields: [...presentFields], rows };
}

/**
 * Threshold below which column encoding costs more bytes than it saves.
 *
 * With type-partitioned blocks, every row in a group has roughly the same
 * field set, so the cross-over is low — typically 3-4 rows. We pick 4 to
 * stay safely above the break-even point even for very narrow (1-2 field)
 * blocks like `tag-member` edges.
 */
const COLUMN_THRESHOLD = 4;

/**
 * Apply column encoding only for large arrays. For small arrays the per-row
 * JSON-overhead of `{key:val}` is already small and verbose form is more
 * legible to a model parsing positionally.
 */
function columnEncodeIfBig(
  records: Record<string, unknown>[],
  fieldOrder: readonly string[],
): { fields: string[]; rows: unknown[][] } | Record<string, unknown>[] {
  if (records.length >= COLUMN_THRESHOLD) return columnEncode(records, fieldOrder);
  return records;
}

/**
 * Build a compact MCP-return-shaped knowledge graph from the DB-layer graph.
 *
 * **Type-partitioned column encoding** (the big win):
 * Nodes are grouped by `type` and each group is column-encoded independently
 * with only the fields its members actually use. This drops both the `type`
 * column (it's the group key, so `"projects"`/`"notes"`/`"cards"`/`"tags"`
 * implies every row's type) and every field that node-type never produces
 * (projects never have `snippet`, tags never have `priority`, …).
 *
 * The same trick applies to edges, partitioned by edge `type` — `s`/`t`/`type`
 * becomes `s`/`t` only when the block is a `project-member`/`tag-member` group
 * (which never have label/weight/section titles), etc.
 *
 * Output shape:
 *   { nodes: { projects?: {...}, notes?: {...}, cards?: {...}, tags?: {...} },
 *     edges: { "project-member"?: {...}, "tag-member"?: {...}, "note-card"?: {...}, … } }
 *
 * A consumer reads `<shape>.nodes[type].rows` and decodes per `<shape>.nodes[type].fields`.
 * An absent block means "no nodes of that type".
 */
function compactGraph(graph: KnowledgeGraph): Record<string, unknown> {
  // Group nodes by type, dropping the (now redundant) `type` field from each row.
  const nodesByType = new Map<string, Record<string, unknown>[]>();
  for (const n of graph.nodes) {
    const compact = compactNode(n);
    const { type } = compact as { type: string };
    delete compact.type;
    let bucket = nodesByType.get(type);
    if (!bucket) { bucket = []; nodesByType.set(type, bucket); }
    bucket.push(compact);
  }
  const nodesObj: Record<string, unknown> = {};
  for (const [type, records] of nodesByType) {
    nodesObj[type] = columnEncodeIfBig(records, NODE_FIELDS);
  }

  // Group edges by type, dropping the `type` field from each row (it's the block key).
  const edgesByType = new Map<string, Record<string, unknown>[]>();
  for (const e of graph.edges) {
    const compact = compactEdge(e);
    const { type } = compact as { type: string };
    delete compact.type;
    let bucket = edgesByType.get(type);
    if (!bucket) { bucket = []; edgesByType.set(type, bucket); }
    bucket.push(compact);
  }
  const edgesObj: Record<string, unknown> = {};
  for (const [type, records] of edgesByType) {
    edgesObj[type] = columnEncodeIfBig(records, EDGE_FIELDS);
  }

  return { nodes: nodesObj, edges: edgesObj };
}

export function get_knowledge_graph(db: Database.Database, args: Record<string, any>) {
  const { workspaceId, projectIds, includeAuto = true, nodeTypes, edgeTypes } = args;
  if (!workspaceId) return { error: "workspaceId is required" };

  // Delegate to the canonical implementation in graph-queries.ts.
  // MCP filter shape maps 1:1 onto GraphFilters:
  //   { projectIds?, includeAuto, nodeTypes?, edgeTypes? }
  const filters: GraphFilters = {
    includeAuto: includeAuto as boolean,
    ...(Array.isArray(projectIds) && projectIds.length > 0 ? { projectIds: projectIds as string[] } : {}),
    ...(Array.isArray(nodeTypes) ? { nodeTypes: nodeTypes as GraphFilters["nodeTypes"] } : {}),
    ...(Array.isArray(edgeTypes) ? { edgeTypes: edgeTypes as EdgeType[] } : {}),
  };

  const graph = getKnowledgeGraph(db, workspaceId as string, filters);
  insertNotification(db, "get_knowledge_graph", "Knowledge graph retrieved", `${graph.nodes.length} nodes, ${graph.edges.length} edges`);
  return compactGraph(graph);
}

export function get_neighbors(db: Database.Database, args: Record<string, any>) {
  const { workspaceId, nodeId, depth = 1, edgeTypes } = args;
  if (!workspaceId || !nodeId) return { error: "workspaceId and nodeId are required" };

  const result: NeighboursResult = getNeighbours(
    db,
    workspaceId as string,
    nodeId as string,
    depth as number,
    Array.isArray(edgeTypes) ? edgeTypes as EdgeType[] : undefined,
  );

  // Slim the center node to just the fields the agent needs for orientation.
  // Each neighbour is reduced to { id, type, title, distance, edgeType, edgeLabel? }.
  const center = result.center ? compactNode(result.center as GraphNode) : null;
  const neighbours = result.neighbours.map((nb) => {
    const node = compactNode(nb.node);
    const edge = compactEdge(nb.edge);
    return {
      id: node.id,
      type: node.type,
      title: node.title,
      ...(node.projectId ? { projectId: node.projectId } : {}),
      ...(node.snippet ? { snippet: node.snippet } : {}),
      distance: nb.distance,
      edgeType: edge.type,
      ...(edge.label !== undefined ? { edgeLabel: edge.label } : {}),
      ...(edge.w !== undefined ? { w: edge.w } : {}),
    };
  });
  return { center, neighbours };
}

export function get_semantic_neighbors(db: Database.Database, args: Record<string, any>) {
  const { noteId, workspaceId } = args;
  if (!noteId) return { error: "noteId is required" };
  if (!workspaceId) return { error: "workspaceId is required" };
  const neighbors = getSemanticNeighbors(db, noteId as string, workspaceId as string);
  insertNotification(db, "get_semantic_neighbors", "Semantic neighbors retrieved", `${neighbors.length} related notes for ${noteId}`);
  // Omit section-title fields when null (most edges don't carry them).
  return {
    noteId,
    neighbors: neighbors.map((nb) => {
      const out: Record<string, unknown> = { noteId: nb.noteId, title: nb.title, weight: nb.weight };
      if (nb.sourceSectionTitle) out.sourceSectionTitle = nb.sourceSectionTitle;
      if (nb.targetSectionTitle) out.targetSectionTitle = nb.targetSectionTitle;
      return out;
    }),
  };
}

export async function search_notes_semantic(db: Database.Database, args: Record<string, any>) {
  const { workspaceId, query, k } = args;
  if (!workspaceId) return { error: "workspaceId is required" };
  if (!query || typeof query !== "string" || !query.trim()) {
    return { error: "query is required" };
  }
  // The standalone MCP server has no Electron dependency, so it can't import
  // `embeddings/client.ts` (which calls `app.getPath("userData")` at module
  // top-level). Instead we call the unified runtime's HTTP API directly via
  // `embedViaRuntime`. If Cairn isn't running and the runtime can't be
  // spawned, we fall back to a graceful error message.
  const { embedViaRuntime } = await import("../../runtime/port-discovery");
  const { searchAdjacent } = await import("../../embeddings/service");
  const { getEmbeddingsSettingsCached } = await import("../../lib/config-cache");
  const { EMBED_MODEL_ID } = await import("../../embeddings/types");

  const settings = getEmbeddingsSettingsCached();
  if (!settings.enabled) {
    return { error: "Embeddings are not enabled. Enable them in Settings → Embeddings first." };
  }
  const model = settings.modelId ?? EMBED_MODEL_ID;
  const kVal = typeof k === "number" && k > 0 ? Math.min(Math.floor(k), 100) : 5;

  // Build an embed function that calls the runtime HTTP API.
  // Returns null when the runtime is unreachable — searchAdjacent would
  // receive null vectors and we catch that before calling it.
  const embedFn = async (texts: string[], task: import("../../embeddings/types").EmbedTask): Promise<number[][]> => {
    const vectors = await embedViaRuntime(texts, task, model);
    if (vectors === null) {
      throw new Error(
        "Embeddings runtime is not available. Start the Cairn app to enable semantic search.",
      );
    }
    return vectors;
  };

  try {
    const results = await searchAdjacent(
      db,
      workspaceId as string,
      query as string,
      kVal,
      [],
      model,
      embedFn,
    );
    insertNotification(db, "search_notes_semantic", "Semantic search", `query="${String(query).slice(0, 60)}" → ${results.length} hits`);
    return {
      query,
      model,
      results,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg };
  }
}

/** Semantic search over TASK CARDS (parallel to search_notes_semantic). */
export async function search_tasks_semantic(db: Database.Database, args: Record<string, any>) {
  const { workspaceId, query, k } = args;
  if (!workspaceId) return { error: "workspaceId is required" };
  if (!query || typeof query !== "string" || !query.trim()) {
    return { error: "query is required" };
  }
  const { embedViaRuntime } = await import("../../runtime/port-discovery");
  const { searchAdjacentTasks } = await import("../../embeddings/service");
  const { getEmbeddingsSettingsCached } = await import("../../lib/config-cache");
  const { EMBED_MODEL_ID } = await import("../../embeddings/types");

  const settings = getEmbeddingsSettingsCached();
  if (!settings.enabled) {
    return { error: "Embeddings are not enabled. Enable them in Settings → Embeddings first." };
  }
  const model = settings.modelId ?? EMBED_MODEL_ID;
  const kVal = typeof k === "number" && k > 0 ? Math.min(Math.floor(k), 100) : 5;

  const embedFn = async (texts: string[], task: import("../../embeddings/types").EmbedTask): Promise<number[][]> => {
    const vectors = await embedViaRuntime(texts, task, model);
    if (vectors === null) {
      throw new Error("Embeddings runtime is not available. Start the Cairn app to enable semantic search.");
    }
    return vectors;
  };

  try {
    const results = await searchAdjacentTasks(db, workspaceId as string, query as string, kVal, model, embedFn);
    insertNotification(db, "search_tasks_semantic", "Semantic task search", `query="${String(query).slice(0, 60)}" → ${results.length} hits`);
    return { query, model, results };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg };
  }
}
