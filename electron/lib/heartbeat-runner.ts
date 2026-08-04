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
import { buildSystemPrompt, TOOLS, type ChatRequest } from "./tools";
import { insertNotification } from "../mcp/db";
import {
  bumpAutomationRunCount,
  createAutomationRun,
  getAutomationById,
  getAutomationRunById,
  hasInFlightRun,
  updateAutomationRun,
  type Automation,
  type AutomationRun,
} from "../db/automation-queries";
import { makeApprovalGate } from "./automation-approval";
import { getExternalToolDefs, checkRequirements } from "./external-tools";

export interface AutomationRunContext {
  db: Database.Database;
  workspacePath: string;
}

const DEFAULT_MAX_STEPS = 10;

/**
 * Run an automation immediately ("Run now"), bypassing the scheduler's clock.
 * Applies the same skip-on-overlap guard, creates a run row, and delegates to
 * runAutomation. Returns the created run id (or null when skipped).
 */
export function runAutomationNow(ctx: AutomationRunContext, automationId: string): string | null {
  const { db } = ctx;
  const automation = getAutomationById(db, automationId);
  if (!automation || !automation.enabled) return null;
  if (hasInFlightRun(db, automationId)) return null;

  bumpAutomationRunCount(db, automationId);
  const run = createAutomationRun(db, automationId, "running");
  const runId = run.id;
  void (async () => {
    try {
      await runAutomation(ctx, run, automation);
    } catch (err) {
      // runAutomation normally sets its own terminal status, but if it throws
      // (e.g. a provider/network failure inside runToolLoop) transition the run
      // out of running so it doesn't block later runs / report a phantom run.
      try {
        updateAutomationRun(db, run.id, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          finishedAt: new Date().toISOString(),
        });
      } catch { /* ignore */ }
    }
  })().catch(() => {});
  return runId;
}

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

  // Connector-aware automation: every declared connector must actually be
  // installed AND enabled + attached (project or global scope), else the run
  // cannot deliver the tools the recipe promises. Fail up front with a
  // connector-specific message instead of silently running without them — a
  // detached connector would otherwise degrade to a data-only run and surprise
  // the user when its expected side effects never happen.
  const requires = automation.requires ?? [];
  if (requires.length > 0) {
    const statuses = checkRequirements(db, automation.workspaceId, automation.projectId ?? "", requires);
    const unavailable = statuses.filter((s) => !s.installed || !s.attached);
    if (unavailable.length > 0) {
      const detail = unavailable
        .map((s) => `${s.name} (${s.kind})${s.installed ? " — not attached to this project" : " — not installed"}`)
        .join(", ");
      const label = `required connector${unavailable.length > 1 ? "s" : ""} unavailable`;
      updateAutomationRun(db, run.id, {
        status: "skipped",
        finishedAt: new Date().toISOString(),
        error: `${label}: ${detail}`,
      });
      insertNotification(db, "automation_run", `Automation skipped: "${automation.name}"`, `Skipped — ${label}: ${detail}`);
      return;
    }
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

  // Connector-aware automation: load the project's attached external tools
  // (MCP servers / custom services) and offer them to the loop as extraTools.
  // getExternalToolDefs filters to enabled + project/global-attached connectors,
  // so a missing/attached-only requirement simply contributes no tools and the
  // agent works with what's actually in scope. External calls stay gated behind
  // the approval inbox by makeApprovalGate (never auto-approved side effects).
  // A connector-load failure is NOT degraded away: the recipe declared these
  // connectors as required, so a run that can't assemble their tools is failed
  // up front rather than silently continuing with built-in tools only.
  // The cast mirrors chat.ts/pi-agent-loop: external defs are OpenAIToolDef[]
  // (open tool-name strings), the loop's extraTools slot is the typed TOOLS.
  let extraTools: typeof TOOLS | undefined;
  if ((automation.requires ?? []).length > 0) {
    try {
      extraTools = (await getExternalToolDefs(
        db,
        automation.workspaceId,
        automation.projectId ?? "",
        automation.requires,
      )) as unknown as typeof TOOLS;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[heartbeat] failed to assemble external tools:", err);
      updateAutomationRun(db, run.id, {
        status: "error",
        finishedAt: new Date().toISOString(),
        error: `Failed to load required connector tools: ${message}`,
      });
      insertNotification(db, "automation_run", `Automation failed: "${automation.name}"`, `Failed to load required connector tools: ${message}`);
      return;
    }
  }

  // Report the tool currently executing into the run's scratch JSON so the
  // Automations view can show a live "running: <tool>" chip while the run is
  // in flight.
  const currentTool = (tool: string) => {
    try {
      const row = getAutomationRunById(db, run.id);
      let scratch: Record<string, unknown> = {};
      if (row?.scratch) {
        try { scratch = JSON.parse(row.scratch) as Record<string, unknown>; } catch { /* ignore */ }
      }
      scratch.currentTool = tool;
      updateAutomationRun(db, run.id, { scratch: JSON.stringify(scratch) });
    } catch { /* best-effort */ }
  };

  // Collect notes/cards the run CREATED or CHANGED so they can be surfaced as
  // navigable artifacts (the loop's emitToolCallDone carries a cairnRef for
  // note/task tools). Only WRITE tools count — get_note/get_task are reads and
  // must not be listed as artifacts. Persisted on the run row at completion.
  const ARTIFACT_TOOLS = new Set([
    "ensure_note", "patch_note", "append_to_note", "rename_note", "instantiate_template",
    "create_task", "update_task", "bulk_update_task_status",
  ]);
  const artifacts: Array<{ type: "note" | "task"; id: string; title: string }> = [];
  const recordArtifact = (tool: string, ref: { type: "note" | "task"; id: string; title: string } | undefined) => {
    if (!ref?.id) return;
    if (!ARTIFACT_TOOLS.has(tool)) return;
    if (!artifacts.some((a) => a.id === ref.id)) artifacts.push(ref);
  };
  const finalScratch = () => (artifacts.length > 0 ? JSON.stringify({ artifacts }) : null);
  // Navigation target for the completion notification: the first note/card the
  // run created when there is one, else the automation itself (opens the
  // Automations view) so the notification is always navigable. Computed AFTER
  // the loop so `artifacts` is fully populated.
  const completionTarget = (): { type: "note" | "task" | "automation"; id: string } =>
    artifacts[0]
      ? { type: artifacts[0].type, id: artifacts[0].id }
      : { type: "automation", id: automation.id };

  const result = await runToolLoop(
    db,
    req,
    workspacePath,
    cached.baseUrl,
    cached.model,
    apiKey,
    messages,
    (e) => currentTool(e.tool),     // emitToolCall — record the active tool
    abortCtrl.signal,
    undefined,                       // getWin
    provider,
    undefined,                       // onUsage
    (e) => recordArtifact(e.tool, e.cairnRef), // emitToolCallDone — collect created/changed notes/cards
    undefined,                       // onToken
    undefined,                       // onThought
    extraTools,                      // connector-aware recipes get their attached external tools
    undefined,                       // toolsOverride
    undefined,                       // argMutator
    makeApprovalGate(db, run, automation),
  );

  if (result.exhausted) {
    updateAutomationRun(db, run.id, {
      status: "done",
      resultNoteId: null,
      error: "Reached the step limit; run may be incomplete.",
      scratch: finalScratch(),
    });
    insertNotification(db, "automation_run", `Automation finished: "${automation.name}"`, summarize(automation, result.content, "completed (step limit reached)"), completionTarget());
    return;
  }

  updateAutomationRun(db, run.id, {
    status: "done",
    resultNoteId: null,
    error: null,
    scratch: finalScratch(),
  });
  insertNotification(db, "automation_run", `Automation finished: "${automation.name}"`, summarize(automation, result.content), completionTarget());
}

/**
 * True for loopback and private-network hosts (localhost, 127.x, 10.x,
 * 172.16–31.x, 192.168.x, 0.0.0.0) — the only endpoints treated as a local
 * model runtime. A remote http(s) endpoint resolves as non-local.
 */
function isLocal(baseUrl: string): boolean {
  const url = baseUrl.trim();
  const m = url.match(/^(https?:\/\/)?([^/:]+)(?::\d+)?(\/.*)?$/i);
  if (!m) return false;
  const host = m[2].toLowerCase();
  if (host === "localhost") return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  const [a, b, c] = host.split(".").map(Number);
  if (a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return a === 0 && b === 0 && c === 0;
}

function summarize(automation: Automation, content: string, suffix = "completed"): string {
  const cleaned = content.trim().replace(/\s+/g, " ");
  const body = cleaned ? cleaned.slice(0, 300) : `Automation "${automation.name}" ${suffix}.`;
  return `"${automation.name}" ${suffix}${cleaned ? ` — ${body}${cleaned.length > 300 ? "…" : ""}` : "."}`;
}
