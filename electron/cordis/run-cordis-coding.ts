/**
 * run-cordis-coding — drive the dsh agent loop for Cairn's CODING agent
 * (Phase 1.5). This is the Cordis equivalent of electron/lib/pi-agent-loop.ts's
 * runAgentLoop, but the dsh agent loop handles the model↔tool↔model iteration
 * internally — this wrapper only:
 *
 *   - mounts the shared Cordis tree + pi-ai adapter (protocol auto-selected),
 *   - mounts the coding capability stack (mountCodingStack) + Cairn data tools,
 *   - mounts cairnCodingPlugin (bridges dsh session/event → pi-agent:* IPC),
 *   - creates a dsh agent for one turn, follows up with the user message,
 *     and awaits idle (the dsh loop runs all tool steps to completion).
 *
 * Every `pi-agent:*` event (token/thought/tool/usage/step/done/error/
 * note-updated/todos/plan-note) is emitted by cairnCodingPlugin via `send`.
 * The terminal promise resolves on `pi-agent:done`/`pi-agent:error` from the
 * plugin's turn/end mapping, or rejects on an unhandled throw.
 */
import { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { Database } from "better-sqlite3";

import { getContext, ensurePiAiAdapter } from "./run-cordis-loop";
import { mountCodingStack } from "./cordis-coding-tools";
import {
  cairnDbPlugin,
  cairnUsagePlugin,
  cairnCodingPlugin,
  cairnQuestionsPlugin,
  cairnSystemPromptPlugin,
  CAIRN_DB,
} from "./cairn-plugins";
import { registerCairnTools, registerExternalCairnTools } from "./cairn-tools";
import { resolveTransport, markCompletionsOnly, readCachedMode, type ApiMode } from "../lib/llm-transport";
import type { ChatRequest } from "../lib/tools";
import type { LLMConfig } from "../lib/llm";

export interface RunCordisCodingOptions {
  db: Database;
  req: ChatRequest;
  workspacePath: string;
  /** The coding session id — scopes every pi-agent:* event + DB todos. */
  sessionId: string;
  cwd: string;
  systemPrompt: string;
  llmConfig: LLMConfig;
  mode: "plan" | "execute";
  /** Emit a pi-agent:* IPC event (sessionId NOT yet tagged by the caller). */
  send: (channel: string, payload: Record<string, unknown>) => void;
  /** Interactive questions (ask_questions) adapter for the coding session. */
  questions?: {
    send: (channel: string, payload: Record<string, unknown>) => void;
    registerPending: (requestId: string, resolve: (answersText: string) => void) => () => void;
  };
  getWin?: () => Electron.BrowserWindow | null;
  signal?: AbortSignal;
}

export interface RunCordisCodingResult {
  /** True if the turn completed cleanly; false on error/abort. */
  ok: boolean;
  error?: string;
}

export async function runCordisCodingLoop(opts: RunCordisCodingOptions): Promise<RunCordisCodingResult> {
  const ctx = await getContext();
  const { db, req, workspacePath, sessionId, cwd, systemPrompt, llmConfig, mode, send, questions, getWin, signal } = opts;

  // Pick the wire protocol the same way chat + the built-in loop do.
  const transport = await resolveTransport(llmConfig.baseUrl, llmConfig.apiKey);
  const apiFor = (m: ApiMode): "openai-responses" | "openai-completions" =>
    m === "responses" ? "openai-responses" : "openai-completions";
  await ensurePiAiAdapter(ctx, {
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    apiKey: llmConfig.apiKey,
    api: apiFor(transport.mode),
  });

  const pluginDisposers: Array<() => void> = [];
  const mount = async (plugin: unknown, config: unknown): Promise<void> => {
    const fiber = ctx.plugin(plugin as never, config as never);
    pluginDisposers.push(() => { fiber.then((f) => { try { f.dispose(); } catch { /* noop */ } }, () => {}); });
    await fiber;
  };
  const codingDisposers: Array<() => void> = [];
  const toolDisposers = registerCairnTools(ctx, {
    getDb: () => (ctx.get(CAIRN_DB) as Database) ?? db,
    req,
    workspacePath,
    llmConfig,
    getWin,
    emit: undefined,
    emitDone: undefined,
  });

  const run = async (): Promise<RunCordisCodingResult> => {
    await mount(cairnDbPlugin, { db });
    await mount(cairnUsagePlugin, {
      threadId: sessionId,
      workspaceId: req.workspaceId ?? "",
      projectId: req.projectId,
      provider: llmConfig.provider,
      model: llmConfig.model,
      baseUrl: llmConfig.baseUrl,
    });
    await mount(cairnSystemPromptPlugin, { systemText: systemPrompt });
    if (questions) {
      await mount(cairnQuestionsPlugin, {
        send: questions.send,
        registerPending: questions.registerPending,
        signal,
      });
    }
    // The dsh coding capability stack (bash/fs/search/editor/todo/plan-mode),
    // cwd-scoped. Order per dsh-base. Mounted before the agent so the tools are
    // registered when the model first requests them.
    codingDisposers.push(await mountCodingStack(ctx, { cwd }));
    const externalDisposers = await registerExternalCairnTools(ctx, {
      db,
      workspaceId: req.workspaceId ?? "",
      projectId: req.projectId ?? "",
    });
    toolDisposers.push(...externalDisposers);

    const selection = { provider: "cairn", model: llmConfig.model };
    const attemptSessionId = SessionId(`${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    // Route every pi-agent:* event to BOTH the renderer (frontend `send`) and a
    // terminal resolver so the turn promise settles on done/error. cairnCodingPlugin
    // is mounted with `send` = this combined function.
    let resolveTerminal: (r: RunCordisCodingResult) => void = () => {};
    const terminal = new Promise<RunCordisCodingResult>((resolve) => { resolveTerminal = resolve; });
    const combinedSend = (channel: string, payload: Record<string, unknown>) => {
      if (channel === "pi-agent:done") { resolveTerminal({ ok: true }); }
      else if (channel === "pi-agent:error") { resolveTerminal({ ok: false, error: (payload.error as string) ?? "Agent error" }); }
      send(channel, payload);
    };

    const { agent } = await ctx.agentLoop.createAgent(ctx, {
      sessionId: attemptSessionId,
      meta: { cwd },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined });
      },
    });
    await agent.whenIdle();

    // Mount the bridge AFTER the agent exists so it knows the dsh attempt id to
    // match events against; it still tags emitted events with the caller's
    // session id.
    await mount(cairnCodingPlugin, { sessionId, matchSessionId: String(attemptSessionId), mode, send: combinedSend, signal });

    agent.followup(
      createUserMessage({ content: [{ type: "text", text: req.message }], source: { kind: "user" } }),
    );

    // Wait for the turn to fully settle (the dsh loop runs all tool steps).
    const doneP = Promise.race([
      terminal,
      agent.whenIdle().then(() => ({ ok: true }) as RunCordisCodingResult),
    ]);
    return await doneP;
  };

  let result: RunCordisCodingResult;
  try {
    result = await run();
  } catch (e) {
    result = { ok: false, error: (e as Error)?.message ?? String(e) };
  } finally {
    codingDisposers.forEach((d) => { try { d(); } catch { /* noop */ } });
    toolDisposers.forEach((d) => { try { d(); } catch { /* noop */ } });
    pluginDisposers.forEach((d) => { try { d(); } catch { /* noop */ } });
  }
  return result;
}
