/** Idea Flow — defined in shared/ so main, preload and the contract use the same types. */

export type {
  IdeaNodeType, IdeaNodeDataMap, IdeaFlowNode, IdeaFlowEdge, IdeaFlow, ResolvedIdeaFlowNode, ResolvedIdeaFlow,
  FlowNodeCreateInput, FlowNodePatch, FlowEdgeCreateInput, FlowAiConfig, UrlMetadata,
} from "../../shared/types/flow";
