/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from "better-sqlite3";
import {
  getKnowledgeGraph,
  getNeighbours,
  getSemanticNeighbors,
  type GraphFilters,
  type EdgeType,
} from "../../db/graph-queries";
import { insertNotification } from "../db";

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
  return graph;
}

export function get_neighbors(db: Database.Database, args: Record<string, any>) {
  const { workspaceId, nodeId, depth = 1, edgeTypes } = args;
  if (!workspaceId || !nodeId) return { error: "workspaceId and nodeId are required" };

  return getNeighbours(
    db,
    workspaceId as string,
    nodeId as string,
    depth as number,
    Array.isArray(edgeTypes) ? edgeTypes as EdgeType[] : undefined,
  );
}

export function get_semantic_neighbors(db: Database.Database, args: Record<string, any>) {
  const { noteId, workspaceId } = args;
  if (!noteId) return { error: "noteId is required" };
  if (!workspaceId) return { error: "workspaceId is required" };
  const neighbors = getSemanticNeighbors(db, noteId as string, workspaceId as string);
  insertNotification(db, "get_semantic_neighbors", "Semantic neighbors retrieved", `${neighbors.length} related notes for ${noteId}`);
  return { noteId, neighbors };
}
