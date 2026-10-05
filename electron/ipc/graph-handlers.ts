/**
 * Cairn — IPC handlers for the Knowledge Graph (`db:graph:*` channels).
 *
 * Thin delegations to `electron/db/graph-queries.ts`.
 *
 * Extracted from the god-file `ipc/handlers.ts` (P2 of the cleanup plan).
 */

import { registerContractHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import { getKnowledgeGraph, getNeighbours, computeAutoRelationships } from "../db/graph-queries";

export function registerGraphHandlers(ctx: DbContext): void {
  registerContractHandle("db:graph:get", (_e, args) => handle(() => getKnowledgeGraph(ctx.db, args.workspaceId, args.filters ?? {})));

  registerContractHandle("db:graph:neighbors", (_e, args) => handle(() => getNeighbours(ctx.db, args.workspaceId, args.nodeId, args.depth ?? 1, args.edgeTypes)));

  registerContractHandle("db:graph:recompute", (_e, args) => handle(() => {
    computeAutoRelationships(ctx.db, args.workspaceId, args.entityIds);
    return { ok: true };
  }));
}
