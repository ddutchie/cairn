/** AI Tool Builder session: streaming events pushed to the renderer, and the prompt it sends. */

export interface ToolBuilderPromptRequest {
  sessionId: string;
  workspaceId: string;
  message: string;
  /** A user-supplied secret the builder may use while probing the service. */
  secret?: { header: string; value: string };
}

/** Incremental assistant text. */
export interface ToolBuilderTokenEvent { sessionId: string; delta: string }
/** A builder tool call started (name + sanitized args). */
export interface ToolBuilderStepEvent { sessionId: string; name: string; args: Record<string, unknown> }
/** The builder is probing this host. */
export interface ToolBuilderProbeHostEvent { sessionId: string; host: string }
/** The builder saved a proposed service or MCP server config. */
export interface ToolBuilderProposalEvent { sessionId: string; toolType: "service" | "mcp"; config: unknown }
/** The builder turn ended: normally, with an error, or aborted. */
export interface ToolBuilderDoneEvent { sessionId: string; error?: string; aborted?: boolean }
