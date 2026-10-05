/** Idea Flow. */

import { invokeContract } from "./ipc";
import type { FlowAiConfig, FlowEdgeCreateInput, FlowNodeCreateInput, FlowNodePatch } from "../../shared/types/flow";

export const flowApi = {
  // ── Idea Flow ────────────────────────────────
  flow: {
    get:         (projectId: string) => invokeContract("db:flow:get", { projectId }),
    node: {
      create:    (node: FlowNodeCreateInput) => invokeContract("db:flow:node:create", node),
      update:    (id: string, patch: FlowNodePatch) => invokeContract("db:flow:node:update", { id, patch }),
      delete:    (id: string) => invokeContract("db:flow:node:delete", { id }),
      summarize: (nodeId: string, config: FlowAiConfig) => invokeContract("db:flow:node:summarize", { nodeId, config }),
    },
    edge: {
      create: (edge: FlowEdgeCreateInput) => invokeContract("db:flow:edge:create", edge),
      delete: (id: string) => invokeContract("db:flow:edge:delete", { id }),
    },
    url: {
      fetch: (url: string) => invokeContract("db:flow:url:fetch", { url }),
    },
  },
} as const;
