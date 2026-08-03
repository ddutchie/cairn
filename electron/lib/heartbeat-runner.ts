/**
 * Cairn — Heartbeat automation runner
 *
 * Executes one scheduled automation as a headless, data-only agent turn.
 *
 * v1 design decisions (see plan note §7 "Persona design"):
 *   - The default persona is the KNOWLEDGE-WORK agent: it runs through
 *     `runToolLoop`, whose `executeTool` surface is Cairn data tools only
 *     (notes/tasks/tags/idea-flow/dashboards/knowledge-graph) — no bash, no
 *     arbitrary file writes. This keeps a background run's blast radius bounded
 *     to Cairn entities, even when it auto-approves its own writes.
 *   - The run drives the user's saved AI/chat connection (cached `aiConfig`).
 *     If none is configured the run is recorded as `skipped` (no silent fail).
 *   - Result delivery: a short summary is written to the run row and an MCP
 *     notification is raised, so the existing in-app notification plumbing
 *     surfaces completion. The automation's own instructions may tell the agent
 *     to create notes/cards — those land in Cairn directly via its tools.
 */

import type Database from "better-sqlite3";
import type { OpenAIMessage } from "./llm";
import { runToolLoop } from "./chat-loop";
import { getCachedConfig } from "./config-cache";
import { resolveLlmApiKey } from "./secure-store";
import { buildSystemPrompt, type ChatRequest } from "./tools";
import { insertNotification } from "../mcp/db";
import {
  updateAutomationRun,
  type Automation,
  type AutomationRun,
} from "../db/automation-queries";

export interface AutomationRunContext {
  db: Database.Database;
  workspacePath: string;
}

const DEFAULT_MAX_STEPS = 10;

/**
 * Run one automation. Sets the run's final status (done / error / skipped) and
 * raises a completion notification. Never throws — the scheduler treats an
 * exception as a run error and records it.
 */
export async function runAutomation(
  ctx: AutomationRunContext,
  run: AutomationRun,
  automation: Automation,
): Promise<void> {
  const { db, workspacePath } = ctx;
  const cached = getCachedConfig().aiConfig;

  if (!cached?.baseUrl || !cached?.model) {
    updateAutomationRun(db, run.id, {
      status: "skipped",
      finishedAt: new Date().toISOString(),
      error: "No AI connection configured. Set one in Settings → AI & Chat.",
    });
    insertNotification(db, "automation_run", `Automation skipped: "${automation.name}"`, "No AI connection configured for background runs.");
    return;
  }

  const apiKey = resolveLlmApiKey(cached.apiKey);
  const provider = (cached.provider ?? (isLocal(cached.baseUrl) ? "localllm" : "openai")) as "openai" | "localllm";
  const abortCtrl = new AbortController();

  const req: ChatRequest = {
    message: automation.instructions,
    threadId: run.id,
    projectId: automation.projectId ?? undefined,
    workspaceId: automation.workspaceId,
    config: {
      baseUrl: cached.baseUrl,
      model: cached.model,
      apiKey: cached.apiKey,
      maxSteps: cached.maxSteps ?? DEFAULT_MAX_STEPS,
      temperature: cached.temperature ?? 0.3,
    },
  };

  const messages: OpenAIMessage[] = [
    { role: "system", content: buildSystemPrompt(req) },
    { role: "user", content: automation.instructions },
  ];

  const result = await runToolLoop(
    db,
    req,
    workspacePath,
    cached.baseUrl,
    cached.model,
    apiKey,
    messages,
    () => {},                        // emitToolCall — headless, no renderer
    abortCtrl.signal,
    undefined,                       // getWin
    provider,
    undefined,                       // onUsage
    undefined,                       // emitToolCallDone
    undefined,                       // onToken
    undefined,                       // onThought
  );

  if (result.exhausted) {
    updateAutomationRun(db, run.id, {
      status: "done",
      resultNoteId: null,
      error: "Reached the step limit; run may be incomplete.",
    });
    insertNotification(db, "automation_run", `Automation finished: "${automation.name}"`, summarize(automation, result.content, "completed (step limit reached)"));
    return;
  }

  updateAutomationRun(db, run.id, {
    status: "done",
    resultNoteId: null,
    error: null,
  });
  insertNotification(db, "automation_run", `Automation finished: "${automation.name}"`, summarize(automation, result.content));
}

function isLocal(baseUrl: string): boolean {
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$|^http:\/\//i.test(baseUrl.trim());
}

function summarize(automation: Automation, content: string, suffix = "completed"): string {
  const cleaned = content.trim().replace(/\s+/g, " ");
  const body = cleaned ? cleaned.slice(0, 300) : `Automation "${automation.name}" ${suffix}.`;
  return `"${automation.name}" ${suffix}${cleaned ? ` — ${body}${cleaned.length > 300 ? "…" : ""}` : "."}`;
}
