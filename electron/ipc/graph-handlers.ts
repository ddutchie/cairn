/**
 * Cairn — IPC handlers for the Knowledge Graph (`db:graph:*` channels).
 *
 * Thin delegations to `electron/db/graph-queries.ts`.
 *
 * Extracted from the god-file `ipc/handlers.ts` (P2 of the cleanup plan).
 */

import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import { getKnowledgeGraph, getNeighbours, computeAutoRelationships } from "../db/graph-queries";
import type { GraphFilters, EdgeType } from "../db/graph-queries";

export function registerGraphHandlers(ctx: DbContext): void {
  registerIpcHandle("db:graph:get", (_e, args: {
    workspaceId: string;
    filters?: GraphFilters;
  }) => handle(() => getKnowledgeGraph(ctx.db, args.workspaceId, args.filters ?? {})));

  registerIpcHandle("db:graph:neighbors", (_e, args: {
    workspaceId: string;
    nodeId: string;
    depth?: number;
    edgeTypes?: EdgeType[];
  }) => handle(() => getNeighbours(ctx.db, args.workspaceId, args.nodeId, args.depth ?? 1, args.edgeTypes)));

  registerIpcHandle("db:graph:recompute", (_e, args: {
    workspaceId: string;
    entityIds?: string[];
  }) => handle(() => {
    computeAutoRelationships(ctx.db, args.workspaceId, args.entityIds);
    return { ok: true };
  }));
}
