/**
 * Cairn's own data tools (notes, tasks, board, idea flow, graph…) as AgentTools.
 * Schemas come from TOOL_SCHEMAS and execution stays in the shared executor, so
 * behaviour is identical to the other surfaces; only the wrapper is new.
 */
import type Database from "better-sqlite3";
import type { BrowserWindow } from "electron";
import * as z from "zod";
import { executeTool } from "../../cordis/chat-executor";
import type { LLMConfig } from "../../lib/llm";
import type { ChatRequest } from "../../lib/tools";
import { TOOL_SCHEMAS, toolParametersJsonSchema } from "../../lib/tool-schemas";
import { APPROVAL_SAFE_TOOLS, approvalPreview } from "../../../shared/agent/tool-risk";
import { defineTool, type AgentTool } from "../tools";
import type { RiskInfo } from "../rules";
import { fail, fromJsonSchema, ok, renderValue } from "./schema";

export interface CairnToolDeps {
  getDb: () => Database.Database;
  req: ChatRequest;
  workspacePath: string;
  llmConfig: LLMConfig;
  getWin?: () => BrowserWindow | null;
  /** Blocks until the human answers; wired to the question UI. Without it ask_questions echoes. */
  askQuestions?: (questions: unknown[], signal?: AbortSignal) => Promise<unknown>;
}

/** Deletes are the one Cairn-data write that is not allowed by default. */
const ASKS_BY_DEFAULT = new Set(["delete"]);

const ASK_QUESTIONS_DESCRIPTION =
  "Ask the user a structured list of clarifying questions via an inline form and WAIT for their answers. This tool BLOCKS: it returns the user's answers as the tool result ({ok:true, answers:[{id, custom}]}). Do NOT write a closing message telling the user to fill in a form — just call the tool, then continue using the answers it returns to complete the task in the same turn.";

export function cairnRisk(name: string): RiskInfo {
  if (APPROVAL_SAFE_TOOLS.has(name)) return { class: "READ" };
  // Not a workspace path, so the workspace-edits preset never covers it: it asks unless a rule says otherwise.
  if (ASKS_BY_DEFAULT.has(name)) return { class: "WRITE_LOCAL" };
  return { class: "WRITE_CAIRN" };
}

export function cairnTools(deps: CairnToolDeps, opts: { exclude?: ReadonlySet<string> } = {}): AgentTool[] {
  const tools: AgentTool[] = [];
  for (const [name, { description, schema }] of Object.entries(TOOL_SCHEMAS) as Array<[string, { description: string; schema: z.ZodType }]>) {
    if (opts.exclude?.has(name)) continue;
    const risk = cairnRisk(name);
    tools.push(defineTool({
      name,
      description: name === "ask_questions" && deps.askQuestions ? ASK_QUESTIONS_DESCRIPTION : description,
      parameters: fromJsonSchema(toolParametersJsonSchema(schema)),
      risk: () => risk,
      preview: (args) => approvalPreview(name, args),
      concurrency: risk.class === "READ" ? "parallel" : "exclusive",
      async execute(args, ctx) {
        if (name === "ask_questions" && deps.askQuestions) {
          const questions = (args as { questions?: unknown[] }).questions;
          if (Array.isArray(questions) && questions.length > 0) {
            try {
              return ok(renderValue({ ok: true, answers: await deps.askQuestions(questions, ctx.signal) }));
            } catch (err) {
              return fail(`ask_questions failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
        const out = await executeTool(
          deps.getDb(), deps.req, deps.workspacePath, deps.llmConfig, name, args as Record<string, unknown>,
          undefined, deps.getWin, undefined, ctx.callId,
        );
        const failed = !!out && typeof out === "object" && typeof (out as { error?: unknown }).error === "string";
        return { content: renderValue(out), ...(failed ? { isError: true } : {}) };
      },
    }));
  }
  return tools;
}
