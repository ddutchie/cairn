/** Tools carry their own risk. See docs/plans/agent-engine-design.md §2. */
import type { Static, TSchema, Tool, ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { RiskInfo } from "./rules";

export interface ToolContext {
  sessionId: string;
  callId: string;
  signal?: AbortSignal;
  workspaceRoot: string;
  /** The call was approved under plan mode: the tool must not change anything (EXEC runs in a read-only sandbox). */
  readOnly?: boolean;
  /** The array the running loop offers tools from; a tool that loads others (tool_search) adds to it. */
  tools?: AgentTool[];
}

export interface ToolOutput {
  content: string | (TextContent | ImageContent)[];
  isError?: boolean;
}

export interface AgentTool<P extends TSchema = TSchema> extends Tool<P> {
  /** Args-aware classification. Throwing is treated as EXEC (fail closed). */
  risk(args: Static<P>): RiskInfo;
  preview?(args: Static<P>): string;
  /** `exclusive` (default) runs alone; `parallel` may overlap with other parallel calls. */
  concurrency?: "parallel" | "exclusive";
  execute(args: Static<P>, ctx: ToolContext): Promise<ToolOutput>;
}

export function defineTool<P extends TSchema>(tool: AgentTool<P>): AgentTool<P> {
  return tool;
}
