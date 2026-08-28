/**
 * Cairn — Heartbeat automation runner
 *
 * Executes one scheduled automation as a headless, data-only agent turn.
 *
 * v1 design decisions (see plan note §7 "Persona design"):
 *   - The default persona is the KNOWLEDGE-WORK agent: it runs through the
 *     Cordis loop, whose `executeTool` surface is Cairn data tools only
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
import path from "path";
import type { OpenAIMessage } from "./llm";
import { getCachedConfig } from "./config-cache";
import { resolveLlmApiKey } from "./secure-store";
import { buildSystemPrompt, TOOLS, type ChatRequest } from "./tools";
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
import { isReadTool, isExternalTool, standingRuleTarget, recordStandingAllowance } from "./automation-approval";
import { getExternalToolDefs, checkRequirements, externalToolLabel } from "./external-tools";
import { recordLlmUsage } from "./usage-recorder";
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
  WRITE_RUN_FILE_TOOL_NAME,
  DELIVER_FILE_TOOL_NAME,
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
import type { RunCordisCodingOptions } from "../cordis/run-cordis-coding";
import { prepareAutomationFolder, readAutomationManifest, resolveAutomationEnv } from "./automation-env";
import { getSecretValue } from "./secure-store";
import { toSlug } from "../shared/text-utils";
import type { SessionProjection } from "../../shared/agent/session-projection";

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

// ── HITL approval forwarding (Cordis) ───────────────────────────────────────
// The coding agent's approval seam blocks on resolve({approved}); for a headless
// heartbeat we forward to the renderer via an automation:run approval event +
// a new automation:approve IPC (resolves this map). Keyed by callId, but scoped
// to runId via composite `${runId}::${callId}` so concurrent runs with the same
// provider callId don't collide (P0-1). Each entry also carries the tool name/args
// so an "always allow" can persist a standing rule, and the db/runId for
// recordStandingAllowance.
interface PendingAutomationApproval {
  tool: string;
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
 * Decide whether a tool call is auto-allowed by the automation's approval
 * policy, or must be forwarded to the user for approval. The Cordis seam
 * resolves via resolve({approved}) — no DB approval inbox behind it (the
 * inbox and its makeApprovalGate/parkAndWait mechanics were retired with
 * the pre-Cordis loop).
 *   - read tools + standing rules → allow
 *   - 'ask' mode → gate every write (forward)
 *   - 'auto' mode → only forward external MCP/service calls when connector-aware
 *   - run_script is always gated (code execution)
 * Standing-rule per-arg matching (e.g. bash:<cmd>) uses the tool's primary
 * identifier (path/note/card/title) — args are not carried through the seam.
 */
function shouldAutoAllowAutomationTool(db: Database.Database, run: AutomationRun, automation: Automation, name: string, args: Record<string, unknown>): boolean {
  if (isReadTool(name)) return true;
  if (name === RUN_SCRIPT_TOOL_NAME) return false;
  const target = standingRuleTarget(name, args);
  if (automation.standingRules.some((r) => r.tool === name && (r.target === undefined || r.target === target))) return true;
  if (automation.approvalMode === "ask") return false;
  const connectorAware = (automation.requires ?? []).length > 0;
  if (connectorAware && isExternalTool(name)) return false;
  return true;
}

const DEFAULT_MAX_STEPS = 10;

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
      // (e.g. a provider/network failure inside the Cordis loop) transition the run
      // out of running so it doesn't block later runs / report a phantom run,
      // persist a run-log.json, and emit `finished` so watchers close cleanly.
      failRun(ctx, run, err instanceof Error ? err.message : String(err));
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

  // const-narrowed copies so the onUsage closure below keeps string types
  // (TS does not preserve property narrowing into closures).
  const cachedModel = cached.model;
  const cachedBaseUrl = cached.baseUrl;

  const req: ChatRequest = {
    message: recipe,
    threadId: run.id,
    projectId: automation.projectId ?? undefined,
    workspaceId: automation.workspaceId,
    config: {
      baseUrl: cached.baseUrl,
      model: cached.model,
      apiKey: cached.apiKey,
      maxSteps: cached.maxSteps ?? DEFAULT_MAX_STEPS,
      // Gate on the model capability: never send temperature to a model that
      // declares `temperature: false`, even if a stale cached value lingers.
      temperature: resolveTemperatureForModel(cached.model, cached.temperature),
    },
  };

  const _messages: OpenAIMessage[] = [
    { role: "system", content: buildSystemPrompt(req) },
    { role: "user", content: recipe },
  ];

  // Connector-aware automation: load the project's attached external tools
  // (MCP servers / custom services) and offer them to the loop as extraTools.
  // getExternalToolDefs filters to enabled + project/global-attached connectors,
  // so a missing/attached-only requirement simply contributes no tools and the
  // agent works with what's actually in scope. External calls stay gated by
  // the Cordis approval waterfall (shouldAutoAllowAutomationTool below +
  // cairnApprovalPlugin) — never auto-approved side effects.
  // A connector-load failure is NOT degraded away: the recipe declared these
  // connectors as required, so a run that can't assemble their tools is failed
  // up front rather than silently continuing with built-in tools only.
  // The cast mirrors chat.ts's shape: external defs are OpenAIToolDef[]
  // (open tool-name strings), the loop's extraTools slot is the typed TOOLS.
  let _extraTools: typeof TOOLS | undefined;
  if ((automation.requires ?? []).length > 0) {
    try {
      _extraTools = (await getExternalToolDefs(
        db,
        automation.workspaceId,
        automation.projectId ?? "",
        automation.requires,
      )) as unknown as typeof TOOLS;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[heartbeat] failed to assemble external tools:", err);
      failRun(ctx, run, `Failed to load required connector tools: ${message}`);
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

  // Live run activity streamed to the renderer (the "watch this run" view).
  // Best-effort: no send sink (tests) → nothing streams, the run still records.
  const emitRun = (event: string, payload: Record<string, unknown>) => {
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

  emitRun("started", { recipe });

  // ── Cordis engine (only path) — run a FULL coding agent in the run folder ──
  // Heartbeat drives runCordisCodingLoop (the full agent: bash/write/edit/read/
  // grep/todo + Cairn data tools + connector/MCP tools + skill) scoped to the
  // per-run folder, so an automation can actually make changes (write files,
  // run scripts, call connectors) — not just a data-only chat turn.
  const runDirForAgent = runDir ?? workspacePath;
  const { runCordisCodingLoop } = await import("../cordis/run-cordis-coding");
  let finalContent = "";
  // Tool name per pending approval callId, captured from the coding agent's
  // `session:tool-confirm-required` event (the seam doesn't carry the name).
  const confirmToolByCallId = new Map<string, string>();
  const loopSend = (channel: string, payload: Record<string, unknown>) => {
    if (channel !== "session:projection") return;
    const projection = payload as unknown as SessionProjection;
    const data = projection.data as Record<string, unknown>;
    if (projection.kind === "approval" && data.status === "required" && typeof data.callId === "string") {
      confirmToolByCallId.set(data.callId as string, (data.name as string | undefined) ?? "tool");
      emitRun("toolConfirmRequired", { tool: data.name, callId: data.callId, label: data.label });
      return;
    }
  };

  const fold = createSessionEventFold({
    onText: (text) => { finalContent += text; emitRun("token", { delta: text }); },
    onReasoning: (text) => { log.thoughts += text; emitRun("thought", { delta: text }); },
    onToolCall: (call) => {
      const label = externalToolLabel(call.name, db);
      currentTool(call.name);
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
    // runCordisCodingLoop's usageSource). Recording it here as well double-counted
    // every automation run in the Usage view.
  });

  // The automation-specific tools registered on the coding agent: run_script,
  // write_run_file (agent→script data bridge into runDir), deliver_file (copy
  // out/ → <workspace>/attachments/<automationId>/ so the note can embed the
  // generated images). Only offered when the folders exist.
  const automationTools: RunCordisCodingOptions["extraTools"] = [];
  if (runScript) automationTools.push({ name: RUN_SCRIPT_TOOL_NAME, description: runScriptToolDefinition.function.description, parameters: runScriptToolDefinition.function.parameters, execute: (a) => runScript(a as never) });
  if (writeRunFileHandler) automationTools.push({ name: WRITE_RUN_FILE_TOOL_NAME, description: writeRunFileToolDefinition.function.description, parameters: writeRunFileToolDefinition.function.parameters, execute: (a) => writeRunFileHandler(a as never) });
  if (deliverFileHandler) automationTools.push({ name: DELIVER_FILE_TOOL_NAME, description: deliverFileToolDefinition.function.description, parameters: deliverFileToolDefinition.function.parameters, execute: (a) => deliverFileHandler(a as never) });

  // Plugin confirmation seam for this run (audit §5 C #9): bind the headless
  // transport so ctx.cairn.confirm during automation turns routes plugin asks
  // through the SAME pending-approval map + auto-allow classifier that native
  // asks use. Unbound after the run settles.
  const { createHeadlessConfirmTransport, setConfirmTransport } = await import("../cordis/approval-transports");
  const { readPendingApprovalArgs } = await import("../cordis/approval-grants");
  setConfirmTransport(run.id, createHeadlessConfirmTransport({
    emitApproval: ({ callId, toolName, title, detail }) => emitRun("approval", { tool: toolName, callId, title, detail }),
    registerPending: (callId, resolve) => {
      const key = automationKey(run.id, callId);
      const trusted = readPendingApprovalArgs(run.id, callId) ?? {};
      pendingAutomationApprovals.set(key, { tool: "plugin_confirm", args: trusted, db, runId: run.id, resolve: (d) => resolve(d.approved) });
      return () => { pendingAutomationApprovals.delete(key); };
    },

  }));

  const codingResult = await runCordisCodingLoop({
    db,
    req,
    workspacePath,
    sessionId: run.id,
    cwd: runDirForAgent,
    systemPrompt: recipe,
    llmConfig: { baseUrl: cached.baseUrl, model: cached.model, apiKey, provider: provider as "openai" | "localllm" },
    mode: "execute",
    sandboxMode: "workspace-write",
    // Automation runs on the coding profile but is its own Usage-view source.
    usageSource: "automation",
    // Ask mode gates writes through the Cordis approval waterfall (native
    // asks + shouldAutoAllowAutomationTool below); Auto skips the gate.
    autoApprove: automation.approvalMode !== "ask",
    signal: abortCtrl.signal,
    send: loopSend,
    extraTools: automationTools,
    approvals: {
      // Forward HITL approvals: auto-allow tools the automation's policy
      // permits (read tools, standing rules, auto-mode built-ins); otherwise
      // emit an automation:run approval event to the renderer and block until
      // the user approves/denies via the automation:approve IPC.
      registerPending: (callId, resolve) => {
        const toolName = confirmToolByCallId.get(callId) ?? "tool";
        confirmToolByCallId.delete(callId);
        const trusted = readPendingApprovalArgs(run.id, callId) ?? {};
        if (shouldAutoAllowAutomationTool(db, run, automation, toolName, trusted)) {
          resolve({ approved: true });
          return () => {};
        }
        const key = automationKey(run.id, callId);
        pendingAutomationApprovals.set(key, { tool: toolName, args: trusted, db, runId: run.id, resolve });
        emitRun("approval", { tool: toolName, callId });
        return () => { pendingAutomationApprovals.delete(key); };
      },
    },
    onSessionEvent: fold,
  });
  const result = { content: finalContent || recipe, exhausted: !codingResult.ok, error: codingResult.error };
  // Run settled — unbind the plugin confirm seam (its asks are all resolved).
  setConfirmTransport(run.id, undefined);
  emitRun("finished", { exhausted: Boolean(result.exhausted), content: result.content, error: result.error });
  log.tokens = result.content;

  // A failed coding turn (provider error, abnormal end) is a run ERROR, not
  // "exhausted" — the coding loop resolves ok:false with the error message.
  if (!codingResult.ok) {
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
