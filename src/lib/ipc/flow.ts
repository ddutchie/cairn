/**
 * Typed client for the Idea Flow (`db:flow:*`) IPC channels. The flow view
 * keeps its own React Flow state (it bypasses the store), so it calls these
 * directly; use `persistFlow` for the fire-and-forget position/size saves.
 */

import type {
  FlowAiConfig, FlowEdgeCreateInput, FlowNodeCreateInput, FlowNodePatch, IdeaFlowEdge, IdeaFlowNode,
  ResolvedIdeaFlow, UrlMetadata,
} from "../../../shared/types/flow";
import { electronCall, persist, type ElectronApi } from "./client";

const flow = <T>(fn: (api: ElectronApi["flow"]) => Promise<T>) => electronCall((e) => fn(e.flow));

export const flowClient = {
  get: (projectId: string): Promise<ResolvedIdeaFlow> => flow((f) => f.get(projectId)),
  createNode: (node: FlowNodeCreateInput): Promise<IdeaFlowNode> => flow((f) => f.node.create(node)),
  updateNode: (id: string, patch: FlowNodePatch): Promise<IdeaFlowNode> => flow((f) => f.node.update(id, patch)),
  deleteNode: (id: string): Promise<void> => flow((f) => f.node.delete(id)),
  /** Summarise the ai_summary node's connected subgraph; the result is also saved on the node. */
  summarize: (nodeId: string, config: FlowAiConfig) => flow((f) => f.node.summarize(nodeId, config)),
  createEdge: (edge: FlowEdgeCreateInput): Promise<IdeaFlowEdge> => flow((f) => f.edge.create(edge)),
  deleteEdge: (id: string): Promise<void> => flow((f) => f.edge.delete(id)),
  fetchUrlMetadata: (url: string): Promise<UrlMetadata> => flow((f) => f.url.fetch(url)),
};

/** Save a flow change in the background; a failure surfaces as a toast. */
export function persistFlow(promise: Promise<unknown>): void {
  persist(promise, "Couldn't save the Idea Flow change");
}
