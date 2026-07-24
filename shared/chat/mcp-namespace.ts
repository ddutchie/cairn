/**
 * MCP tool namespacing + shape conversion — the PURE helpers shared by the
 * desktop (electron/lib/mcp-client.ts) and mobile (mobile/src/chat/mcp-client.ts)
 * MCP clients, so both namespace tools, convert MCP tool defs to OpenAI function
 * defs, and stringify tool results IDENTICALLY.
 *
 * Framework-free: no SDK import, no I/O. The platform clients own the transport,
 * connection cache, and auth; they call these for the pure bits.
 */

/** Namespacing prefix so MCP tools never collide with built-ins or each other. */
const NS_PREFIX = "mcp__";
const NS_SEP = "__";

/** Build the namespaced tool name exposed to the model: mcp__<serverId>__<tool>. */
export function namespaceToolName(serverId: string, toolName: string): string {
  return `${NS_PREFIX}${serverId}${NS_SEP}${toolName}`;
}

/**
 * Parse a namespaced tool name back into { serverId, toolName }. Returns null if
 * the name is not an MCP-namespaced name (so callers can fall through to other
 * tool sources), or if it is malformed (empty server id or tool name).
 */
export function parseToolName(namespaced: string): { serverId: string; toolName: string } | null {
  if (!namespaced.startsWith(NS_PREFIX)) return null;
  const rest = namespaced.slice(NS_PREFIX.length);
  const sep = rest.indexOf(NS_SEP);
  if (sep <= 0 || sep >= rest.length - NS_SEP.length) return null;
  return {
    serverId: rest.slice(0, sep),
    toolName: rest.slice(sep + NS_SEP.length),
  };
}

/** True if a tool name belongs to an MCP server (vs a built-in or service). */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(NS_PREFIX);
}

/** OpenAI function-calling tool definition shape. */
export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Minimal shape of an MCP tool definition as returned by listTools(). */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Convert a server's MCP tool list into namespaced OpenAI function defs. Tools
 * with no input schema get an empty-object schema (the model still must call
 * with `{}`).
 */
export function mcpToolsToOpenAI(serverId: string, tools: McpToolDef[]): OpenAIToolDef[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: namespaceToolName(serverId, t.name),
      description: t.description ?? "",
      parameters: t.inputSchema ?? { type: "object", properties: {} },
    },
  }));
}

/**
 * Collapse an MCP CallToolResult content array into a single string. Text parts
 * are concatenated; non-text parts are JSON-stringified. An `isError` result is
 * prefixed with "Error: " so the model can react to it.
 */
export function stringifyToolResult(res: unknown): string {
  const r = res as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  if (!r || !Array.isArray(r.content)) return JSON.stringify(res);
  const text = r.content
    .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : JSON.stringify(c)))
    .join("\n");
  return r.isError ? `Error: ${text}` : text;
}
