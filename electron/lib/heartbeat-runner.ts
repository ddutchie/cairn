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
import path from "path";
import type { OpenAIMessage } from "./llm";
import { runToolLoop } from "./chat-loop";
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
import { makeApprovalGate } from "./automation-approval";
import { getExternalToolDefs, checkRequirements } from "./external-tools";
import { recordLlmUsage } from "./usage-recorder";
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
  type AutomationScriptContext,
  type RunScriptArgs,
  type RunScriptHandler,
  type WriteRunFileArgs,
  type WriteRunFileHandler,
  type DeliverFileArgs,
  type DeliverFileHandler,
} from "./automation-script";
import { prepareAutomationFolder, readAutomationManifest, resolveAutomationEnv } from "./automation-env";
import { getSecretValue } from "./secure-store";
import { toSlug } from "../shared/text-utils";

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
      // (e.g. a provider/network failure inside runToolLoop) transition the run
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

  const messages: OpenAIMessage[] = [
    { role: "system", content: buildSystemPrompt(req) },
    { role: "user", content: recipe },
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
  const result = await runToolLoop(
    db,
    req,
    workspacePath,
    cached.baseUrl,
    cached.model,
    apiKey,
    messages,
    (e) => {                       // emitToolCall — record + stream the active tool
      currentTool(e.tool);
      logTool(e.tool, e.label, e.args);
      emitRun("tool", { tool: e.tool, label: e.label, args: e.args, status: "start" });
    },
    abortCtrl.signal,
    undefined,                       // getWin
    provider,
    // Persist one usage row per automation round for the Usage view (previously
    // usage was never captured for background runs).
    (pt, ct, rt, costUsd, cacheRead, cacheCreate) => {
      recordLlmUsage({
        source: "automation",
        sessionId: run.id,
        projectId: automation.projectId ?? undefined,
        workspaceId: automation.workspaceId,
        provider,
        model: cachedModel,
        baseUrl: cachedBaseUrl,
        promptTokens: pt,
        completionTokens: ct,
        reasoningTokens: rt ?? 0,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreate,
        costUsd,
      });
    },
    (e) => {                       // emitToolCallDone — collect artifacts + stream result
      recordArtifact(e.tool, e.cairnRef);
      logToolDone(e.tool, e.ok, e.output, e.error);
      flushLog(); // incremental transcript — survives a crash mid-run
      emitRun("toolDone", { tool: e.tool, ok: e.ok, output: e.output, error: e.error, cairnRef: e.cairnRef });
    },
    (delta) => emitRun("token", { delta }),   // onToken (live stream; final text lands in the log)
    (delta) => { log.thoughts += delta; emitRun("thought", { delta }); }, // onThought
    extraTools,                      // connector-aware recipes get their attached external tools
    undefined,                       // toolsOverride
    undefined,                       // argMutator
    makeApprovalGate(db, run, automation, abortCtrl.signal),
    runScript,                       // run_script executor (scripts/ + run cwd + out/)
    writeRunFileHandler,             // write_run_file executor (agent→script data bridge)
    deliverFileHandler,              // deliver_file executor (out/ → attachments for the note)
  );
  emitRun("finished", { exhausted: Boolean(result.exhausted), content: result.content });
  log.tokens = result.content;

  if (result.exhausted) {
    finaliseLog("exhausted", "Reached the step limit; run may be incomplete.");
    updateAutomationRun(db, run.id, {
      status: "exhausted",
      resultNoteId: null,
      error: "Reached the step limit; run may be incomplete.",
      scratch: finalScratch(),
    });
    insertNotification(db, "automation_run", `Automation finished: "${automation.name}"`, summarize(automation, result.content, "completed (step limit reached)"), completionTarget());
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
