/**
 * cairn-tools — bridge Cairn's ~45 built-in tools onto the dsh tool registry
 * (`ctx.tools`). Each tool keeps its real schema and its existing `executeTool`
 * body (which handles the DB read/write + external MCP/services dispatch), so
 * behavior is unchanged — the model just reaches them through the Cordis loop.
 *
 * Phase 1: convert each Zod tool schema to the dsh `ValueSchemaSpec` parameter
 * DSL, and use an unconstrained `json` output (dsh's `{ type: "json" }` node)
 * so every Cairn tool's heterogeneous return value is accepted and rendered as
 * text for the model.
 */
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import z from "zod";
import { TOOL_SCHEMAS } from "../lib/tool-schemas";
import { executeTool } from "../ipc/chat-executor";
import type { ChatRequest } from "../lib/tools";
import type { LLMConfig } from "../lib/llm";
import type { Database } from "better-sqlite3";

/** Author-facing value schema node (dsh DSL subset we generate). */
type VNode =
  | { type: "string"; required?: true; description?: string; enum?: string[] }
  | { type: "number"; required?: true; description?: string }
  | { type: "integer"; required?: true; description?: string }
  | { type: "boolean"; required?: true; description?: string }
  | { type: "null"; required?: true }
  | { type: "array"; required?: true; items?: VNode; description?: string }
  | { type: "object"; required?: true; additionalProperties?: boolean; properties?: Record<string, VNode>; description?: string }
  | { type: "json"; required?: true; description?: string };

interface ExecutionCtx {
  db: Database;
  req: ChatRequest;
  workspacePath: string;
  llmConfig: LLMConfig;
  getWin?: () => Electron.BrowserWindow | null;
  emit?: (e: { tool: string; label: string; args: Record<string, unknown>; callId?: string }) => void;
  emitDone?: (e: { tool: string; cairnRef?: { type: "note" | "task"; id: string; title: string }; externalRef?: { url: string; title?: string; snippet?: string }; output?: string; callId?: string; ok?: boolean; error?: string }) => void;
}

/**
 * Convert a Zod tool schema (as produced by z.toJSONSchema draft-07) into a
 * dsh ValueSchemaSpec object. Handles the common node types; unknown nodes
 * degrade to `json`.
 */
function zodJsonToVNode(json: unknown, topLevel = false): VNode {
  if (!json || typeof json !== "object") return { type: "json" };
  const j = json as Record<string, unknown>;
  const req = topLevel ? undefined : (j.required === true ? { required: true as const } : {});
  const desc = typeof j.description === "string" ? { description: j.description } : {};
  switch (j.type) {
    case "string":
      return { type: "string", ...req, ...desc, ...(Array.isArray(j.enum) ? { enum: j.enum as string[] } : {}) };
    case "number":
      return { type: "number", ...req, ...desc };
    case "integer":
      return { type: "integer", ...req, ...desc };
    case "boolean":
      return { type: "boolean", ...req, ...desc };
    case "null":
      return { type: "null", ...req };
    case "array": {
      const items = (j.items as Record<string, unknown>) ?? {};
      return { type: "array", ...req, ...desc, items: zodJsonToVNode(items) };
    }
    case "object": {
      const props = (j.properties as Record<string, unknown>) ?? {};
      const properties: Record<string, VNode> = {};
      for (const [k, v] of Object.entries(props)) {
        properties[k] = zodJsonToVNode(v as Record<string, unknown>);
      }
      return {
        type: "object",
        ...req,
        ...desc,
        additionalProperties: true,
        properties,
      };
    }
    default:
      return { type: "json", ...req, ...desc };
  }
}

/** Build one dsh ToolDefinition from a Cairn tool schema. */
export function buildCairnTool(
  name: string,
  description: string,
  schema: z.ZodType,
  exec: ExecutionCtx,
): ToolDefinition {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-07" }) as Record<string, unknown>;
  const params = (jsonSchema.properties ?? {}) as Record<string, unknown>;
  const properties: Record<string, VNode> = {};
  for (const [k, v] of Object.entries(params)) {
    properties[k] = zodJsonToVNode(v as Record<string, unknown>);
  }
  const requiredSet = new Set<string>(Array.isArray(jsonSchema.required) ? (jsonSchema.required as string[]) : []);
  for (const k of requiredSet) {
    if (properties[k]) (properties[k] as { required?: boolean }).required = true;
  }

  return defineTool({
    name,
    description,
    parameters: properties as never,
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args) {
      const out = await executeTool(
        exec.db,
        exec.req,
        exec.workspacePath,
        exec.llmConfig,
        name,
        args as Record<string, unknown>,
        exec.emit,
        exec.getWin,
        exec.emitDone,
        `cordis-${Math.random().toString(36).slice(2, 8)}`,
      );
      return out as never;
    },
  });
}

/** Register every Cairn tool onto a dsh context. Returns disposers. */
export function registerCairnTools(ctx: import("@deepseek-ai/cordis").Context, exec: ExecutionCtx): Array<() => void> {
  const disposers: Array<() => void> = [];
  for (const [name, { description, schema }] of Object.entries(TOOL_SCHEMAS) as Array<[string, { description: string; schema: z.ZodType }]>) {
    try {
      const def = buildCairnTool(name, description, schema, exec);
      disposers.push(ctx.tools.register(def));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[cordis] failed to register tool ${name}:`, err);
    }
  }
  return disposers;
}
