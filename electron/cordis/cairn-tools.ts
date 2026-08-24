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
import "./ctx-augment";
import z from "zod";
import { TOOL_SCHEMAS } from "../lib/tool-schemas";
import { executeTool } from "./chat-executor";
import type { ChatRequest } from "../lib/tools";
import type { LLMConfig } from "../lib/llm";
import type { Database } from "better-sqlite3";
import { extractCairnRef } from "./session-replay";


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
  /** Resolve the Cairn Database handle (normally from the cairnDb service). */
  getDb: () => Database;
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
  ctx?: import("@deepseek-ai/cordis").Context,
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
      presentationMeta: (_args, value) => {
        const ref = extractCairnRef(name, value);
        return (ref ? { cairnRef: ref } : null) as never;
      },
    },


    async execute(args, runContext) {
      // Subagent-originated tool calls must NOT fire the MAIN thread's emit/emitDone
      // (session:tool) — those chips belong to the parent
      // chat bubble. A child session (header.origin === 'subagent') is already
      // bridged to session:subagent-tool-call by cairnSubagentPlugin via session/event.
      // Without this guard, a subagent's get_active_context/get_note leaked chips
      // into the main chat (the "tool chips spread between subagent and main" bug).
      const rc = runContext as unknown as { agent?: { session?: { header?: { origin?: string } } } } | undefined;
      const isSubagentCall = rc?.agent?.session?.header?.origin === "subagent";
      const emit = isSubagentCall ? undefined : exec.emit;
      const emitDone = isSubagentCall ? undefined : exec.emitDone;
      // ask_questions routes through the dsh user-questions seam so the turn
      // BLOCKS until the human answers and the answers become this tool's result
      // (same-turn), instead of the shared executor's synchronous echo. The
      // cairnQuestionsPlugin provider bridges ask() ⇄ the renderer form.
      if (name === "ask_questions" && ctx) {
        const uq = ctx.userQuestions;
        const raw = (args as { questions?: unknown[] }).questions ?? [];
        if (uq && Array.isArray(raw) && raw.length > 0) {
          try {
            const answer = await uq.ask({ questions: raw as never });
            return { ok: true, answers: answer.answers } as never;
          } catch (err) {
            return { ok: false, error: `ask_questions failed: ${(err as Error)?.message ?? String(err)}` } as never;
          }
        }
      }
      const out = await executeTool(
        exec.getDb(),
        exec.req,
        exec.workspacePath,
        exec.llmConfig,
        name,
        args as Record<string, unknown>,
        emit,
        exec.getWin,
        emitDone,
        `cordis-${Math.random().toString(36).slice(2, 8)}`,
      );
      return out as never;
    },
  });
}

/** Tool names that MUTATE user data destructively and MUST NOT be registered
 *  on the chat context. Chat has no per-tool approval gate (approvals live on
 *  the coding-agent path only), so any deletion request from the chat
 *  assistant would run without confirmation. The coding agent, on which
 *  deletions are gated, still registers these normally.
 *
 *  Read-only counterparts (get_note, get_task, get_project_context_pack, …)
 *  and non-destructive writes (upsert_project, update_task, etc.) are NOT on
 *  this list — the chat can still create/update, just not delete. */
export const CHAT_FORBIDDEN_TOOLS = new Set([
  "delete_note",
  "delete_task",
  "delete_project",
]);

/**
 * Register every Cairn tool onto a dsh context. Returns disposers.
 * Optional exclude set skips specific tool names — used by the chat path to
 * withhold destructive deletions that have no approval gate on that surface.
 */
export function registerCairnTools(
  ctx: import("@deepseek-ai/cordis").Context,
  exec: ExecutionCtx,
  opts: { exclude?: ReadonlySet<string> } = {},
): Array<() => void> {
  const disposers: Array<() => void> = [];
  const exclude = opts.exclude;
  for (const [name, { description, schema }] of Object.entries(TOOL_SCHEMAS) as Array<[string, { description: string; schema: z.ZodType }]>) {
    if (exclude?.has(name)) continue;
    try {
      // In the Cordis engine, ask_questions BLOCKS and returns the user's actual
      // answers (via ctx.userQuestions.ask()) — unlike the built-in loop where it
      // echoes and the answer arrives as a new turn. Override the description so
      // the model waits for and USES the returned answers in the same turn,
      // instead of writing a "fill them in and submit" sign-off and stopping.
      const desc = name === "ask_questions"
        ? "Ask the user a structured list of clarifying questions via an inline form and WAIT for their answers. This tool BLOCKS: it returns the user's answers as the tool result ({ok:true, answers:[{id, custom}]}). Do NOT write a closing message telling the user to fill in a form — just call the tool, then continue using the answers it returns to complete the task in the same turn."
        : description;
      const def = buildCairnTool(name, desc, schema, exec, ctx);
      disposers.push(ctx.tools.register(def));
    } catch (err) {

      console.error(`[cordis] failed to register tool ${name}:`, err);
    }
  }
  return disposers;
}

// ── cairn-external-tools ────────────────────────────────────────────────────
// Bridge user-configured MCP servers + custom HTTP services onto ctx.tools.
// getExternalToolDefs returns OpenAI-shaped defs (name/description/parameters);
// we convert each to a dsh ToolDefinition that dispatches to
// executeExternalTool (the existing connector execution path).

/** Convert an OpenAI parameters JSON-schema object to the dsh value schema DSL. */
function paramsToVNode(json: Record<string, unknown>): Record<string, VNode> {
  const props = (json.properties ?? {}) as Record<string, unknown>;
  const required = new Set<string>(Array.isArray(json.required) ? (json.required as string[]) : []);
  const properties: Record<string, VNode> = {};
  for (const [k, v] of Object.entries(props)) {
    const node = zodJsonToVNode(v as Record<string, unknown>);
    if (required.has(k)) (node as { required?: boolean }).required = true;
    properties[k] = node;
  }
  return properties;
}

export interface ExternalToolsExecCtx {
  db: Database;
  workspaceId: string;
  projectId: string;
}

/**
 * Register the user's external tools (MCP servers + custom services) onto a dsh
 * context. Resolves the in-scope defs once at registration time; each tool
 * dispatches to executeExternalTool at execution time. Returns disposers.
 */
export async function registerExternalCairnTools(ctx: import("@deepseek-ai/cordis").Context, exec: ExternalToolsExecCtx): Promise<Array<() => void>> {
  const disposers: Array<() => void> = [];
  let defs: Array<{ function: { name: string; description: string; parameters: Record<string, unknown> } }> = [];
  try {
    const { getExternalToolDefs } = await import("../lib/external-tools");
    defs = (await getExternalToolDefs(exec.db, exec.workspaceId, exec.projectId)) as typeof defs;
  } catch (err) {
     
    console.error("[cordis] failed to resolve external tool defs:", err);
    return disposers;
  }
  for (const def of defs) {
    const { name, description, parameters } = def.function;
    try {
      const tool = defineTool({
        name,
        description,
        parameters: paramsToVNode(parameters) as never,
        output: {
          schema: { type: "json" },
          render: (_args, value) => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
        },
        async execute(args) {
          const { executeExternalTool } = await import("../lib/external-tools");
          const out = await executeExternalTool(exec.db, exec.workspaceId, exec.projectId, name, args as Record<string, unknown>);
          return out as never;
        },
      });
      disposers.push(ctx.tools.register(tool));
    } catch (err) {
       
      console.error(`[cordis] failed to register external tool ${name}:`, err);
    }
  }
  return disposers;
}
