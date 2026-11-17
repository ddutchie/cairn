/**
 * Cairn — Heartbeat automation runner
 *
 * Executes one scheduled automation as a headless, data-only agent turn.
 *
 * v1 design decisions (see plan note §7 "Persona design"):
 *   - The default persona is the KNOWLEDGE-WORK agent: it runs through the
 *     engine loop, whose `executeTool` surface is Cairn data tools only
 *     (notes/tasks/tags/idea-flow/knowledge-graph) — no bash, no
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
import path from "path";
import type { OpenAIMessage } from "./llm";
import { cachedMaxOutputTokens, getCachedConfig } from "./config-cache";
import { resolveLlmApiKey } from "./secure-store";
import { buildSystemPrompt, type ChatRequest } from "./chat-prompt";
import { resolveTemperatureForModel } from "./model-pricing";
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
import { isReadTool, isExternalTool, standingRuleTarget, standingRuleCoversTool, recordStandingAllowance } from "./automation-approval";
import { getExternalToolDefs, checkRequirements, externalToolLabel } from "./external-tools";
import { createSessionEventFold } from "../../shared/agent/session-event-fold";
import {
  automationFolderDir,
  automationOutDir,
  automationScriptsDir,
  ensureAutomationDir,
  ensureAutomationRunDir,
  cleanupOldRunDirs,
  readRunLog,
  writeRunLog,
  type RunLog,
} from "./automation-folder";
import {
  runAutomationScript,
  writeRunFile,
  deliverFile,
  RUN_SCRIPT_TOOL_NAME,
  runScriptToolDefinition,
  writeRunFileToolDefinition,
  deliverFileToolDefinition,
  type AutomationScriptContext,
  type RunScriptArgs,
  type RunScriptHandler,
  type WriteRunFileArgs,
  type WriteRunFileHandler,
  type DeliverFileArgs,
  type DeliverFileHandler,
} from "./automation-script";
import { runEngineAutomation, respondEngineAsk } from "../ipc/engine-bridge";
import { defineTool, fromJsonSchema, type AgentTool, type HostSend } from "../agent/index";
import type { DbContext } from "../ipc/result-helpers";
import type { SessionEventEnvelope } from "../../shared/agent/session-event";
import { prepareAutomationFolder, readAutomationManifest, resolveAutomationEnv } from "./automation-env";
import { getSecretValue } from "./secure-store";
import { toSlug } from "../host-shared/text-utils";
import type { SessionProjection } from "../../shared/agent/session-projection";
import { errMsg } from "../host-shared/errors";
import {
  TODAY_RESULT_CHARS, includedProjects, isTodayAutomation, loadLatestTodayBrief, pruneTodayFiles, readTodayMarks, readTodaySettings, saveTodayBrief,
  snapshotTodayBrief, takeTodayRebuild, TODAY_SYSTEM_PROMPT, todayLookBackFrom, todayPrompt, todayReasoningEffort, todayToolFilter,
} from "./today";
import { projectFacts } from "./today-facts";
import { todayBriefTools, type TodayBriefSession } from "./today-tools";
import { finishBrief, startRefresh } from "../../shared/today/brief-edit";
import { noteRunActivity } from "./run-activity";
import { localDate, TODAY_NOTE_CHARS } from "../../shared/today/brief";

export interface AutomationRunContext {
  db: Database.Database;
  workspacePath: string;
  /**
   * Optional IPC sink for live run activity (automation:run:* events). When
   * absent (tests), the runner records everything to the run row but streams
   * nothing.
   */
  send?: (channel: string, payload: unknown) => void;
}

// ── HITL approval forwarding (engine) ───────────────────────────────────────
// The coding agent's approval seam blocks on resolve({approved}); for a headless
// heartbeat we forward to the renderer via an automation:run approval event +
// a new automation:approve IPC (resolves this map). Keyed by callId, but scoped
// to runId via composite `${runId}::${callId}` so concurrent runs with the same
// provider callId don't collide (P0-1). Each entry also carries the tool name/args
// so an "always allow" can persist a standing rule, and the db/runId for
// recordStandingAllowance.
interface PendingAutomationApproval {
  tool: string;
  /** Display name for the approval card and the notification. */
  label: string;
  callId: string;
  args: Record<string, unknown>;
  db: Database.Database;
  runId: string;
  resolve: (decision: { approved: boolean; grant?: "session" | "command" }) => void;
}
const pendingAutomationApprovals = new Map<string, PendingAutomationApproval>();
function automationKey(runId: string, callId: string): string { return `${runId}::${callId}`; }
/**
 * Resolve a pending automation tool approval (called by the automation:approve IPC).
 * Accepts either a bare callId (legacy/best-effort) or composite runId::callId.
 * @param callId - the approval's callId (or composite key).
 * @param approved - approve or deny.
 * @param grant - "session" remembers for the rest of this turn; "always" persists
 *   an "always allow" standing rule on the automation so future runs skip it.
 */
export function resolveAutomationApproval(callId: string, approved: boolean, grant?: "session" | "always"): void {
  let pending = pendingAutomationApprovals.get(callId);
  let key = callId;
  if (!pending) {
    // Try any runId prefix match for bare callId fallback.
    for (const [k, v] of pendingAutomationApprovals.entries()) {
      if (k.endsWith(`::${callId}`)) { pending = v; key = k; break; }
    }
    if (!pending) return;
  }
  pendingAutomationApprovals.delete(key);
  if (grant === "always") {
    recordStandingAllowance(pending.db, pending.runId, pending.tool, pending.args);
  }
  pending.resolve({ approved, grant: grant === "session" ? "session" : undefined });
}

/**
 * The tool calls a run is waiting on, oldest first. The run watcher reads this
 * when it opens: an approval raised before then is not replayed as an event.
 */
export function listPendingAutomationApprovals(runId: string): Array<{ callId: string; tool: string; label: string }> {
  return [...pendingAutomationApprovals.values()]
    .filter((p) => p.runId === runId)
    .map((p) => ({ callId: p.callId, tool: p.tool, label: p.label }));
}

/**
 * Decide whether a tool call is auto-allowed by the automation's approval
 * policy, or must be forwarded to the user for approval. The engine seam
 * resolves via resolve({approved}) — no DB approval inbox behind it (the
 * inbox and its makeApprovalGate/parkAndWait mechanics were retired with
 * the legacy loop).
 *   - read tools + standing rules → allow
 *   - 'ask' mode → gate every write (forward)
 *   - 'auto' mode → only forward external MCP/service calls when connector-aware
 *   - 'auto-connectors' mode → as 'auto', but the tools of the connectors the
 *     automation selected (`connectorTools`) run without asking
 *   - run_script is always gated (code execution)
 * Standing-rule per-arg matching (e.g. bash:<cmd>) uses the tool's primary
 * identifier (path/note/card/title) — args are not carried through the seam.
 */
function shouldAutoAllowAutomationTool(automation: Automation, name: string, args: Record<string, unknown>, connectorTools: ReadonlySet<string>): boolean {
  if (isReadTool(name)) return true;
  if (name === RUN_SCRIPT_TOOL_NAME) return false;
  const target = standingRuleTarget(name, args);
  if (automation.standingRules.some((r) => standingRuleCoversTool(r.tool, name, args) && (r.target === undefined || r.target === target))) return true;
  if (automation.approvalMode === "ask") return false;
  // 'auto-connectors' lets through only the selected connectors' tools, also
  // when none are selected (then no connector call runs unasked).
  if (automation.approvalMode === "auto-connectors" && isExternalTool(name)) return connectorTools.has(name);
  const connectorAware = (automation.requires ?? []).length > 0;
  if (connectorAware && isExternalTool(name)) return false;
  return true;
}

const DEFAULT_MAX_STEPS = 10;
/** Today reads several connectors before it writes; give it room. */
const TODAY_MIN_STEPS = 30;
const APPROVAL_NOTICE_COOLDOWN_MS = 30_000;

/** Project display name from the DB, or null for workspace-scoped automations. */
function projectNameOf(db: Database.Database, projectId: string | null): string | null {
  if (!projectId) return null;
  const row = db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name?: string } | undefined;
  return row?.name ?? null;
}

/**
 * Fail a run outside the normal completion path (a throw inside runAutomation,
 * or a connector-tool assembly failure). Sets the terminal error status, writes
 * a minimal run-log.json when a run folder exists so a crashed run stays
 * inspectable, and emits the `automation:run` `finished` event so the run
 * watcher never spins forever. Never throws.
 */
function failRun(ctx: AutomationRunContext, run: AutomationRun, error: string): void {
  const { db } = ctx;
  const finishedAt = new Date().toISOString();
  try {
    updateAutomationRun(db, run.id, { status: "error", error, finishedAt });
  } catch { /* best-effort */ }
  try {
    const row = getAutomationRunById(db, run.id);
    if (row?.runDir) {
      // Merge the failure into any incrementally-flushed transcript instead of
      // replacing it — a run that crashed after N tool calls keeps that history.
      const existing = readRunLog(row.runDir) ?? {
        automationId: row.automationId,
        runId: run.id,
        startedAt: row.startedAt ?? finishedAt,
        recipe: "",
        tools: [],
        tokens: "",
        thoughts: "",
      };
      writeRunLog(row.runDir, { ...existing, status: "error", error, finishedAt });
    }
  } catch { /* best-effort */ }
  try {
    noteRunActivity(run.automationId, "finished", {});
    ctx.send?.("automation:run", { event: "finished", automationId: run.automationId, runId: run.id, exhausted: false, error });
  } catch { /* best-effort */ }
}

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
      // (e.g. a provider/network failure inside the engine loop) transition the run
      // out of running so it doesn't block later runs / report a phantom run,
      // persist a run-log.json, and emit `finished` so watchers close cleanly.
      failRun(ctx, run, errMsg(err));
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
  // Taken first, before any skip below, so a skipped run can't leave a rebuild for a later Refresh.
  const rebuild = isTodayAutomation(automation) && takeTodayRebuild(automation.id);

  // A per-project Today row from the preview: the workspace row replaces it
  // (moved over the next time Today is read), so it never runs a brief.
  if (isTodayAutomation(automation) && automation.projectId) {
    updateAutomationRun(db, run.id, {
      status: "skipped",
      finishedAt: new Date().toISOString(),
      error: "Today is now one brief per workspace. Open Today to move this schedule over.",
    });
    return;
  }

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
  const provider = (cached.provider ?? "openai") as "openai";
  const today = isTodayAutomation(automation);
  const maxSteps = today ? Math.max(cached.maxSteps ?? DEFAULT_MAX_STEPS, TODAY_MIN_STEPS) : (cached.maxSteps ?? DEFAULT_MAX_STEPS);

  // ── Folder plumbing (phase 1/2) ───────────────────────────────────────────
  // Every run gets a working directory under <project>/.automations/<id>/runs/
  // (dot-prefixed → hidden from the notes browser, file-watcher, and Obsidian).
  // scripts/ + out/ are ensured once; the per-run folder is recorded on the run
  // row and is the cwd for run_script. Best-effort: a filesystem failure records
  // no runDir but never fails the automation.
  const projectName = projectNameOf(db, automation.projectId);
  const automationDir = automationFolderDir(workspacePath, automation.id, projectName);
  let runDir: string | null = null;
  let scriptsDir: string | null = null;
  let outDir: string | null = null;
  try {
    ensureAutomationDir(automationDir);
    scriptsDir = automationScriptsDir(automationDir);
    outDir = automationOutDir(automationDir);
    runDir = ensureAutomationRunDir(automationDir, run.id);
    updateAutomationRun(db, run.id, { runDir });
    // Materialize the folder's .env (non-secrets) + a minimal manifest.json
    // (only created once — never clobbers an agent-authored manifest).
    prepareAutomationFolder(automationDir, automation);
  } catch (err) {
    console.warn("[heartbeat] failed to prepare automation run folder:", err);
  }
  // Prune completed run folders at the end of a run (best-effort, keeps KEEP_RUN_DIRS).
  const cleanupRuns = () => {
    try { cleanupOldRunDirs(automationDir); } catch { /* best-effort */ }
  };

  // Resolve the automation's env for this run. Non-secrets come from the row;
  // secrets are decrypted from the keychain and injected directly into the
  // run_script child env (never written to the .env file on disk).
  const resolvedEnv = resolveAutomationEnv(automation, (name) => getSecretValue("automation", automation.id, name));

  // ── run_script executor (phase 2) ──────────────────────────────────────────
  // Executes a named script from scripts/ with the run folder as cwd and the
  // durable out/ folder exposed via CAIRN_OUT_DIR. Only offered to the model
  // when the folders exist (a filesystem failure degrades to data-only runs).
  const runScript: RunScriptHandler | undefined = scriptsDir && outDir && runDir
    ? async (scriptArgs: RunScriptArgs) => {
        const scriptCtx: AutomationScriptContext = {
          scriptsDir,
          cwd: runDir!,
          outDir,
          env: {
            CAIRN_WORKSPACE_DIR: workspacePath,
            CAIRN_PROJECT_DIR: projectName ? path.join(workspacePath, toSlug(projectName)) : workspacePath,
            CAIRN_RUN_ID: run.id,
            // The automation's env vars — secrets resolved from the keychain.
            ...resolvedEnv,
          },
          signal: abortCtrl.signal,
        };
        return runAutomationScript(scriptArgs, scriptCtx);
      }
    : undefined;

  // ── write_run_file executor ────────────────────────────────────────────────
  // The agent→script data bridge: the agent (data-only) can't write files, so
  // this writes into the RUN folder only — staging connector results as JSON
  // for run_script to consume (-input <file>). Bounded to the ephemeral run
  // dir; offered only when the run folder exists.
  const writeRunFileHandler: WriteRunFileHandler | undefined = runDir
    ? async (fileArgs: WriteRunFileArgs) => writeRunFile(fileArgs, { runDir })
    : undefined;

  // ── deliver_file executor ───────────────────────────────────────────────────
  // Copies a generated out/ file into <workspace>/attachments/<automationId>/
  // (served by the asset:// protocol) so the delivered note can embed images.
  const deliverFileHandler: DeliverFileHandler | undefined = outDir
    ? async (fileArgs: DeliverFileArgs) => deliverFile(fileArgs, {
        outDir,
        workspacePath,
        automationId: automation.id,
      })
    : undefined;

  // The recipe to execute: the agent-authored manifest.json `instructions`
  // (written during Develop) win over the automation row, so the built script
  // is actually called end-to-end. Falls back to the row when no manifest.
  let recipe = automation.instructions;
  try {
    const manifest = readAutomationManifest(automationDir);
    if (manifest?.instructions && manifest.instructions.trim()) recipe = manifest.instructions.trim();
  } catch {
    /* fall back to the row */
  }
  // Today's recipe belongs to the app, not the row: a row saved by an older
  // build keeps its old text, so the current one is used on every run, with
  // today's date and Cairn's facts for every included project.
  const todaySettings = today ? readTodaySettings(workspacePath, automation) : null;
  const todayProjects = todaySettings ? includedProjects(db, automation.workspaceId, todaySettings) : [];
  // The brief this run starts from: the same day's (a refresh), or the last day's open items (carried over).
  const todayPrevious = today ? loadLatestTodayBrief(workspacePath, automation) : null;
  if (today) {
    recipe = todayPrompt(projectFacts(db, automation.workspaceId, todayProjects), rebuild ? null : todayLookBackFrom(db, automation.id, run.id), new Date(), rebuild);
  }

  const req: ChatRequest = {
    message: recipe,
    threadId: run.id,
    projectId: automation.projectId ?? undefined,
    workspaceId: automation.workspaceId,
    config: {
      baseUrl: cached.baseUrl,
      model: cached.model,
      apiKey: cached.apiKey,
      maxSteps,
      // Gate on the model capability: never send temperature to a model that
      // declares `temperature: false`, even if a stale cached value lingers.
      temperature: resolveTemperatureForModel(cached.model, cached.temperature),
    },
  };

  const _messages: OpenAIMessage[] = [
    { role: "system", content: buildSystemPrompt(req) },
    { role: "user", content: recipe },
  ];

  // Connector-aware automation: the engine offers the project's attached
  // connector tools itself; here the selected connectors are resolved up front.
  // A connector-load failure is NOT degraded away: the recipe declared these
  // connectors as required, so a run that can't assemble their tools is failed
  // rather than silently continuing with built-in tools only.
  // The names of the selected connectors' tools: what 'auto-connectors' mode
  // lets through without asking. Other attached connectors still ask.
  const connectorTools = new Set<string>();
  if ((automation.requires ?? []).length > 0) {
    try {
      const defs = await getExternalToolDefs(
        db,
        automation.workspaceId,
        automation.projectId ?? "",
        automation.requires,
      );
      for (const def of defs) connectorTools.add(def.function.name);
    } catch (err) {
      const message = errMsg(err);
      console.error("[heartbeat] failed to assemble external tools:", err);
      failRun(ctx, run, `Failed to load required connector tools: ${message}`);
      insertNotification(db, "automation_run", `Automation failed: "${automation.name}"`, `Failed to load required connector tools: ${message}`);
      return;
    }
  }

  // Report the tool currently executing into the run's scratch JSON so the
  // Automations view can show a live "running: <tool>" chip while the run is
  // in flight.
  const currentTool = (tool: string, label?: string, args?: unknown) => {
    try {
      const row = getAutomationRunById(db, run.id);
      let scratch: Record<string, unknown> = {};
      if (row?.scratch) {
        try { scratch = JSON.parse(row.scratch) as Record<string, unknown>; } catch { /* ignore */ }
      }
      scratch.currentTool = tool;
      scratch.currentToolLabel = label;
      scratch.currentToolArgs = args && typeof args === "object" ? args : undefined;
      updateAutomationRun(db, run.id, { scratch: JSON.stringify(scratch) });
    } catch { /* best-effort */ }
  };

  // Live run activity streamed to the renderer (the "watch this run" view).
  // Best-effort: no send sink (tests) → nothing streams, the run still records.
  const emitRun = (event: string, payload: Record<string, unknown>) => {
    noteRunActivity(automation.id, event, payload);
    try {
      ctx.send?.("automation:run", {
        event,
        automationId: automation.id,
        runId: run.id,
        ...payload,
      });
    } catch { /* best-effort */ }
  };

  // Persisted run transcript — the inspectable "what happened" record, written
  // to <runDir>/run-log.json on completion.
  const log: RunLog = {
    automationId: automation.id,
    runId: run.id,
    startedAt: new Date().toISOString(),
    recipe,
    status: "running",
    tools: [],
    tokens: "",
    thoughts: "",
  };
  const logTool = (name: string, label: string | undefined, args: Record<string, unknown> | undefined) => {
    log.tools.push({ name, label, args });
  };
  const logToolDone = (name: string, ok: boolean | undefined, output: string | undefined, error: string | undefined) => {
    const last = [...log.tools].reverse().find((t) => t.name === name && t.ok === undefined);
    if (last) {
      last.ok = ok;
      last.output = output;
      last.error = error;
    }
  };
  // Write the running transcript to disk after each completed tool, so a crash
  // mid-run (or an app quit) keeps the transcript-so-far instead of losing it —
  // startup recovery can then show exactly how far the run got. Cheap enough at
  // per-tool granularity (synchronous, small JSON).
  const flushLog = () => { if (runDir) writeRunLog(runDir, log); };
  const finaliseLog = (status: string, error?: string | null) => {
    log.status = status;
    log.error = error ?? null;
    log.finishedAt = new Date().toISOString();
    flushLog();
  };

  // Collect notes/cards the run CREATED or CHANGED so they can be surfaced as
  // navigable artifacts (the loop's emitToolCallDone carries a cairnRef for
  // note/task tools). Only WRITE tools count — get_item is a read and
  // must not be listed as artifacts. Persisted on the run row at completion.
  const ARTIFACT_TOOLS = new Set([
    "ensure_note", "edit_note", "update_notes",
    "create_task", "update_tasks", "task_progress",
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

  emitRun("started", { recipe });

  // ── engine (only path) — run a FULL coding agent in the run folder ──
  // Heartbeat drives runEngineCodingLoop (the full agent: bash/write/edit/read/
  // grep/todo + Cairn data tools + connector/MCP tools + skill) scoped to the
  // per-run folder, so an automation can actually make changes (write files,
  // run scripts, call connectors) — not just a data-only chat turn.
  const runDirForAgent = runDir ?? workspacePath;
  let finalContent = "";
  // The last assistant message with text: Today keeps it with the brief as the run's note.
  let lastMessage = "";
  const fold = createSessionEventFold({
    onText: (text) => { finalContent += text; emitRun("token", { delta: text }); },
    onAssistantMessage: (m) => { if (m.text.trim()) lastMessage = m.text.trim(); },
    onReasoning: (text) => { log.thoughts += text; emitRun("thought", { delta: text }); },
    onToolCall: (call) => {
      const label = externalToolLabel(call.name, db);
      currentTool(call.name, label, call.args);
      logTool(call.name, label, call.args);
      emitRun("tool", { tool: call.name, label, args: call.args, status: "start", callId: call.callId });
    },
    onToolResult: (result) => {
      recordArtifact(result.name, result.meta?.cairnRef as { type: "note" | "task"; id: string; title: string } | undefined);
      logToolDone(result.name, result.ok, result.output, result.error);
      flushLog();
      emitRun("toolDone", { tool: result.name, ok: result.ok, output: result.output, error: result.error, callId: result.callId });
    },
    // Usage is recorded by cairnUsagePlugin (source "automation", passed via
    // runEngineCodingLoop's usageSource). Recording it here as well double-counted
    // every automation run in the Usage view.
  });

  // The automation-specific tools registered on the coding agent: run_script,
  // write_run_file (agent→script data bridge into runDir), deliver_file (copy
  // out/ → <workspace>/attachments/<automationId>/ so the note can embed the
  // generated images). Only offered when the folders exist.
  const automationTools: AgentTool[] = [];
  const addTool = (def: { function: { name: string; description: string; parameters: Record<string, unknown> } }, risk: AgentTool["risk"], run: (args: never) => Promise<unknown>) => {
    automationTools.push(defineTool({
      name: def.function.name,
      description: def.function.description,
      parameters: fromJsonSchema(def.function.parameters),
      risk,
      execute: async (args) => {
        const out = await run(args as never);
        return { content: typeof out === "string" ? out : JSON.stringify(out) };
      },
    }));
  };
  if (runScript) addTool(runScriptToolDefinition as never, () => ({ class: "EXEC" }), (a) => runScript(a));
  if (writeRunFileHandler) addTool(writeRunFileToolDefinition as never, () => ({ class: "WRITE_LOCAL" }), (a) => writeRunFileHandler(a));
  if (deliverFileHandler) addTool(deliverFileToolDefinition as never, () => ({ class: "WRITE_LOCAL" }), (a) => deliverFileHandler(a));

  // Today builds its brief through tools. Each change is saved and pushed, so the view fills in while the run gathers.
  let todaySession: TodayBriefSession | null = null;
  // Returns why the save failed, or null; the session remembers it so a failed last save fails the run.
  const saveToday = (brief: TodayBriefSession["brief"]): string | null => {
    let saveError: string | null = null;
    try { saveTodayBrief(workspacePath, automation, brief); } catch (err) {
      saveError = errMsg(err);
      console.warn("[heartbeat] failed to save Today brief:", err);
    }
    if (todaySession) todaySession.saveError = saveError ?? undefined;
    try { ctx.send?.("today:updated", { workspaceId: automation.workspaceId, status: brief.status, ...(saveError ? { saveError } : {}) }); } catch { /* best-effort */ }
    return saveError;
  };
  if (today) {
    const now = new Date();
    // Marks first: pruning can delete the previous brief's marks file after a long gap.
    const marks = todayPrevious ? readTodayMarks(workspacePath, automation, todayPrevious.date) : null;
    try {
      pruneTodayFiles(workspacePath, automation, now);
      // A refresh overwrites the day's file: keep the version it replaces for the history.
      if (todayPrevious && todayPrevious.status === "ready" && todayPrevious.date === localDate(now)) {
        snapshotTodayBrief(workspacePath, automation, todayPrevious);
      }
    } catch (err) { console.warn("[heartbeat] Today history upkeep failed:", err); }
    todaySession = { brief: startRefresh(todayPrevious, marks, now), finished: false };
    saveToday(todaySession.brief);
    automationTools.push(...todayBriefTools(todaySession, saveToday));
  }

  // Aborted by session:abort (which stops the engine run) or by the run_script handler's own signal.
  const abortCtrl = new AbortController();

  // One notification per burst of asks, not one per call.
  let lastApprovalNotice = 0;
  // Arguments per call, so a standing rule can match on the real target when an ask arrives.
  const argsByCall = new Map<string, Record<string, unknown>>();
  const engineCtx = { db, workspacePath, getWin: () => null } as unknown as DbContext;
  const tap: HostSend = (channel, payload) => {
    if (channel === "session:event") {
      const event = (payload as SessionEventEnvelope).event;
      if (event.type === "tool/call") {
        const d = event.data as { callId?: string; args?: Record<string, unknown> };
        if (d.callId) argsByCall.set(d.callId, d.args ?? {});
      }
      fold(event);
      return;
    }
    const projection = payload as SessionProjection;
    if (projection.kind !== "approval") return;
    const data = projection.data as Record<string, unknown>;
    if (typeof data.callId !== "string") return;
    const callId = data.callId;
    const key = automationKey(run.id, callId);
    if (data.status === "resolved") {
      // Decided by anyone, including a timeout: every watcher drops its card.
      // Sent even when the entry is already gone: a decision made in one window
      // removes it before the engine reports back, and other windows still show it.
      pendingAutomationApprovals.delete(key);
      emitRun("approvalResolved", { callId });
      return;
    }
    if (data.status !== "required") return;
    const toolName = (data.name as string | undefined) ?? "tool";
    const nonce = data.nonce as string | undefined;
    const trusted = argsByCall.get(callId) ?? {};
    emitRun("toolConfirmRequired", { tool: toolName, callId, label: data.label });
    // Only a routine ask may be answered for the user. One raised for a protected path, a repeated
    // call, a rule or a hook, or to leave the shell sandbox, is asked whatever the approval mode.
    const routine = (data.by === undefined || data.by === "mode") && data.escalation !== true;
    // Today is read-only and unattended: decide every ask here, never wait on the user. Anything but a
    // routine ask is denied (nobody is there to review it), and so is a resource read from an app that's off.
    if (today) {
      const server = typeof trusted.server === "string" ? trusted.server : null;
      const appOff = !!server && todaySettings!.excludedApps.includes(server);
      const allowed = routine && !appOff && todayToolFilter(todaySettings!)(toolName);
      respondEngineAsk(engineCtx, run.id, callId, nonce, { approved: allowed });
      return;
    }
    if (routine && shouldAutoAllowAutomationTool(automation, toolName, trusted, connectorTools)) {
      respondEngineAsk(engineCtx, run.id, callId, nonce, { approved: true });
      return;
    }
    const label = externalToolLabel(toolName, db);
    pendingAutomationApprovals.set(key, {
      tool: toolName, label, callId, args: trusted, db, runId: run.id,
      resolve: (d) => { respondEngineAsk(engineCtx, run.id, callId, nonce, { approved: d.approved, grant: d.grant }); },
    });
    emitRun("approval", { tool: toolName, label, callId });
    // Nobody may be watching: without this the run waits unseen until the ask times out.
    const now = Date.now();
    if (now - lastApprovalNotice >= APPROVAL_NOTICE_COOLDOWN_MS) {
      lastApprovalNotice = now;
      insertNotification(db, "automation_approval", `Automation waiting for approval: "${automation.name}"`,
        `${label} needs your approval. Open Automations and watch the run to approve or deny it.`, { type: "automation", id: automation.id });
    }
  };

  let codingResult: { ok: boolean; error?: string } = { ok: true };
  let turnError: string | undefined;
  const tapWithErrors: HostSend = (channel, payload) => {
    if (channel === "session:projection") {
      const p = payload as SessionProjection;
      if (p.kind === "error") turnError = (p.data as { message?: string }).message ?? "Agent turn failed.";
    }
    if (channel === "session:event") {
      const ev = (payload as SessionEventEnvelope).event;
      if (ev.type === "turn/end") {
        const kind = (ev.data as { reason?: { kind?: string; message?: string } }).reason?.kind;
        if (kind && kind !== "stop") turnError ??= `Agent turn ended: ${kind}.`;
      }
    }
    tap(channel, payload);
  };
  try {
    await runEngineAutomation({
      ctx: engineCtx,
      sessionId: run.id,
      prompt: recipe,
      cwd: runDirForAgent,
      projectId: automation.projectId ?? undefined,
      workspaceId: automation.workspaceId,
      // Today reads the connectors of every project it covers.
      externalProjectIds: today ? todayProjects.map((p) => p.id) : undefined,
      externalExclude: todaySettings?.excludedApps,
      externalResultChars: today ? TODAY_RESULT_CHARS : undefined,
      // Today's searches go out in one round; run them at once, so the round takes as long as the slowest app.
      externalParallel: today,
      usageSource: today ? "today" : undefined,
      // Today has its own: the chat assistant's tells the model to write without asking and reply in markdown.
      systemPrompt: today ? TODAY_SYSTEM_PROMPT : buildSystemPrompt(req),
      llmConfig: {
        baseUrl: cached.baseUrl, model: cached.model, apiKey, provider: provider as "openai",
        maxSteps, temperature: req.config?.temperature,
        // The chat's context window and output cap. Without them the engine assumes a 128K window and
        // squeezes the reply to fit, so a long run ends with a 1-token "output limit" reply.
        contextWindow: cached.contextLimit, maxTokens: cachedMaxOutputTokens(cached),
        // The active connection's wire protocol and reasoning effort, as chat sends them.
        apiMode: (cached.savedProviders?.find((p) => p.id === cached.activeProviderId)?.apiMode ?? cached.apiMode) as "responses" | "completions" | "anthropic-messages" | undefined,
        reasoningEffort: today ? todayReasoningEffort(cached.reasoningEffort) : cached.reasoningEffort as "off" | "low" | "medium" | "high" | undefined,
      } as never,
      extraTools: automationTools,
      // Today never sees a tool that writes, so no saved "always allow" grant can let one run.
      toolFilter: todaySettings ? todayToolFilter(todaySettings) : undefined,
      // Today keeps the tool schemas too, for its export (scripts/today-replay.mjs replays a run from it).
      onSetup: (setup) => { log.setup = today ? setup : { ...setup, toolDefs: undefined }; },
      autoApprove: automation.approvalMode !== "ask",
      signal: abortCtrl.signal,
      tap: tapWithErrors,
    });
    if (turnError) codingResult = { ok: false, error: turnError };
  } catch (err) {
    codingResult = { ok: false, error: errMsg(err) };
  } finally {
    for (const k of [...pendingAutomationApprovals.keys()]) if (k.startsWith(`${run.id}::`)) pendingAutomationApprovals.delete(k);
  }
  const result = { content: finalContent || recipe, exhausted: !codingResult.ok, error: codingResult.error };
  emitRun("finished", { exhausted: Boolean(result.exhausted), content: result.content, error: result.error });
  log.tokens = result.content;

  // A failed coding turn (provider error, abnormal end) is a run ERROR, not
  // "exhausted" — the coding loop resolves ok:false with the error message.
  if (!codingResult.ok) {
    // Today: close what the run found so far, so the file isn't left "gathering" and the view hears the run ended.
    if (todaySession && !todaySession.finished) saveToday(finishBrief(todaySession.brief, {}, new Date()));
    finaliseLog("error", result.error ?? "Agent turn failed.");
    updateAutomationRun(db, run.id, {
      status: "error",
      resultNoteId: null,
      error: result.error ?? "Agent turn failed.",
      scratch: finalScratch(),
    });
    insertNotification(db, "automation_run", `Automation failed: "${automation.name}"`, summarize(automation, result.content, "failed"), completionTarget());
    cleanupRuns();
    return;
  }

  // Today: a run that never called today_finish still shows what it found, but the run is an error so the view can say why.
  if (todaySession) {
    const unfinished = !todaySession.finished;
    if (unfinished) finishBrief(todaySession.brief, {}, new Date());
    // The closing message comes after today_finish, so it's saved with a second write.
    todaySession.brief.note = lastMessage ? lastMessage.slice(0, TODAY_NOTE_CHARS) : undefined;
    saveToday(todaySession.brief);
    const b = todaySession.brief;
    const empty = b.needYou.length + b.prepared.length + b.fyi.length + b.events.length === 0;
    if (todaySession.saveError) {
      const error = `The brief couldn't be saved: ${todaySession.saveError}`;
      finaliseLog("error", error);
      updateAutomationRun(db, run.id, { status: "error", resultNoteId: null, error, scratch: finalScratch() });
      insertNotification(db, "automation_run", `Automation failed: "${automation.name}"`, error, completionTarget());
      cleanupRuns();
      return;
    }
    if (unfinished) {
      const error = empty
        ? "The run ended without building a brief. Try again, or pick a more capable model."
        : "The run ended before finishing the brief, so some apps may be missing.";
      finaliseLog("error", error);
      updateAutomationRun(db, run.id, { status: "error", resultNoteId: null, error, scratch: finalScratch() });
      cleanupRuns();
      return;
    }
  }

  updateAutomationRun(db, run.id, {
    status: "done",
    resultNoteId: null,
    error: null,
    scratch: finalScratch(),
  });
  finaliseLog("done");
  insertNotification(db, "automation_run", `Automation finished: "${automation.name}"`, summarize(automation, result.content), completionTarget());
  cleanupRuns();
}

function summarize(automation: Automation, content: string, suffix = "completed"): string {
  const cleaned = content.trim().replace(/\s+/g, " ");
  const body = cleaned ? cleaned.slice(0, 300) : `Automation "${automation.name}" ${suffix}.`;
  return `"${automation.name}" ${suffix}${cleaned ? ` — ${body}${cleaned.length > 300 ? "…" : ""}` : "."}`;
}
