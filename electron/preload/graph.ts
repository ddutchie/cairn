/** Knowledge graph and local embeddings. */

import { invokeContract, onIpcEvent } from "./ipc";
import type { GraphEdgeType } from "../../shared/types/domain";
import type { EmbeddingDownloadProgress } from "../../shared/types/embeddings";
import type { GraphQueryFilters } from "../../shared/types/graph";

export const graphApi = {
  // ── Knowledge Graph ───────────────────────────
  graph: {
    get:       (workspaceId: string, filters?: GraphQueryFilters) => invokeContract("db:graph:get", { workspaceId, filters }),
    neighbors: (workspaceId: string, nodeId: string, depth?: number, edgeTypes?: GraphEdgeType[]) =>
                 invokeContract("db:graph:neighbors", { workspaceId, nodeId, depth, edgeTypes }),
    recompute: (workspaceId: string, entityIds?: string[]) => invokeContract("db:graph:recompute", { workspaceId, entityIds }),
  },

  // ── Embeddings (local semantic search + knowledge graph) ────
  embeddings: {
    status: () => invokeContract("embeddings:status"),
    stop: () => invokeContract("embeddings:stop"),
    needsReindex: () => invokeContract("embeddings:needsReindex"),
    projections: (workspaceId: string) => invokeContract("embeddings:projections", { workspaceId }),
    reindex: (workspaceId: string, noteIds?: string[], model?: string) =>
      invokeContract("db:embeddings:reindex", { workspaceId, noteIds, model }),
    search: (workspaceId: string, queryText: string, opts?: {
      queryNoteId?: string;
      k?: number;
      excludeIds?: string[];
      model?: string;
    }) => invokeContract("db:embeddings:search", { workspaceId, queryText, ...opts }),
    recomputeProjections: (workspaceId: string, model?: string) =>
      invokeContract("db:embeddings:recomputeProjections", { workspaceId, model }),
    models: {
      list: () => invokeContract("embeddings:models:list"),
      install: (modelId: string) => invokeContract("embeddings:models:install", { modelId }),
      remove: (modelId: string) => invokeContract("embeddings:models:remove", { modelId }),
      setDefault: (modelId: string) => invokeContract("embeddings:models:setDefault", { modelId }),
      onProgress: (cb: (e: EmbeddingDownloadProgress) => void) => onIpcEvent("embeddings:download-progress", cb),
    },
    getSettings: () => invokeContract("app:getEmbeddingsSettings"),
    saveSettings: (config: { enabled?: boolean; modelId?: string }) => invokeContract("app:saveEmbeddingsSettings", { config }),
  },
} as const;
