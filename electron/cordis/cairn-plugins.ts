/**
 * cairn-plugins — Cairn's own Cordis plugins (the parity layer).
 *
 * Each plugin mounts on the shared Cordis tree and maps a dsh concern onto
 * Cairn's existing persistence + usage surfaces, so Cairn's renderer, mobile
 * bridge, and Usage view work unchanged over the dsh agent loop.
 *
 *  - cairnDbPlugin   — owns the Database handle on the context (`ctx.cairnDb`).
 *                      The single ABI-safe way Cairn plugins touch SQLite.
 *  - cairnSessionPlugin — subscribe to `session/event` and persist messages to
 *                      `chat_threads` / `chat_messages`.
 *  - cairnUsagePlugin  — on usage chunks, call recordLlmUsage (Usage view).
 *
 * These are pure persistence plugins; live IPC streaming (chat:token /
 * chat:usage) stays in run-cordis-loop's drain so the renderer gets realtime
 * deltas while the DB gets the durable record.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type Database from "better-sqlite3";
import { addChatMessage, upsertChatThread } from "../db/queries";
import { recordLlmUsage } from "../lib/usage-recorder";
import { newId } from "../db/utils";
import { saveSessionTodos, getSessionTodos } from "../db/queries";
import { resultContentError } from "../lib/tool-result";
import { toolCallSignature, DOOM_LOOP_THRESHOLD } from "../lib/pi-agent-loop";

/** Service key under which cairnDbPlugin provides the Database handle. */
export const CAIRN_DB = "cairnDb";

// ── cairn-system-prompt ───────────────────────────────────────────────────────
export interface CairnSystemPromptConfig {
  /**
   * The fully-assembled Cairn system prompt for this turn: identity + tool
   * rules + date (buildSystemPrompt), personality layered on (withPersonality),
   * and any prior conversation folded in as a transcript. Registered as the
   * first prompt section the model reads.
   */
  systemText: string;
}

/**
 * Registers Cairn's per-turn system prompt as an ordered prompt section on the
 * Cordis tree, mirroring how dsh's own capability plugins (tool-fs, tool-web,
 * …) contribute prompt guidance via `ctx.systemPrompt.section()`. Mounted per
 * call (the prompt is per-request: date, personality, project context,
 * history), so it's disposed with the turn's fiber like the other cairn-*
 * plugins — no inline `setup()` wiring in the loop.
 *
 * The section name is distinct from dsh's reserved `deployment:persona` (which
 * the system-prompt plugin owns and we leave empty), and its low order places
 * Cairn's identity first. dsh suppresses its own harness identity
 * (includeHarnessIdentity:false), so this is the only identity the model sees.
 */
export function cairnSystemPromptPlugin(ctx: Context, config: CairnSystemPromptConfig): void {
  const { systemText } = config;
  if (!systemText) return;
  // Unique section name per mount: the plugin is mounted per turn on the shared
  // context, and dsh throws on a duplicate section name — so two overlapping
  // turns would collide on a fixed name. The disposer (tied to this fiber)
  // removes it when the turn ends.
  const name = `cairn:system:${newId()}`;
  (ctx as unknown as { systemPrompt: { section: (s: { name: string; order: number; text: string }) => void } })
    .systemPrompt.section({ name, order: -100, text: systemText });
}
// Cordis gates `ctx.systemPrompt` behind an explicit injection declaration.
cairnSystemPromptPlugin.inject = ["systemPrompt"];

// ── cairn-db ────────────────────────────────────────────────────────────────
export interface CairnDbConfig {
  db: Database.Database;
}

/**
 * Owns the Database handle on the Cordis context. Other Cairn plugins read it
 * via `ctx.get(CAIRN_DB)` (or declare it in `inject`). Constructing the
 * Database stays in electron/db/client.ts (ABI rules); this plugin just
 * carries the already-built handle.
 */
export function cairnDbPlugin(ctx: Context, config: CairnDbConfig): (() => void) | void {
  // Idempotent: the plugin is mounted per turn on the shared context, and its
  // disposer runs asynchronously — a back-to-back turn (or a test) can re-mount
  // before teardown settles. `provide` throws on a duplicate key, so skip when
  // the handle is already present (it's the same singleton db either way).
  const existing = (ctx as unknown as { get: (name: string) => unknown }).get(CAIRN_DB);
  if (existing) return;
  return ctx.provide(CAIRN_DB, config.db);
}

function getDb(ctx: Context): Database.Database | undefined {
  const get = (ctx as unknown as { get: (name: string) => unknown }).get;
  return get(CAIRN_DB) as Database.Database | undefined;
}

// ── cairn-session ───────────────────────────────────────────────────────────
export interface CairnSessionConfig {
  threadId: string;
  workspaceId: string;
  projectId?: string;
}

/** Extract the plain-text content of a message event. */
function eventText(event: SessionEvent): string {
  if (event.type === "assistant/message") {
    return (event.data as { message: { content: Array<{ type: string; text?: string }> } })
      .message.content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("");
  }
  if (event.type === "user/message") {
    const content = (event.data as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content;
    if (Array.isArray(content)) {
      return content.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("");
    }
    return "";
  }
  return "";
}

/** Extract reasoning text + items from an assistant/message event. */
function eventReasoning(event: SessionEvent): { reasoning: string; items?: Array<Record<string, unknown>> } {
  if (event.type !== "assistant/message") return { reasoning: "" };
  const content = (event.data as unknown as { message: { content: Array<Record<string, unknown>> } }).message.content;
  let reasoning = "";
  const items: Array<Record<string, unknown>> = [];
  for (const b of content) {
    if (b.type === "reasoning") reasoning += String(b.text ?? "");
    else if (b.reasoning && typeof b.reasoning === "string") items.push(b as Record<string, unknown>);
  }
  return { reasoning, items: items.length ? items : undefined };
}

/** Persist a dsh session's durable events into Cairn's chat tables. */
export function cairnSessionPlugin(ctx: Context, config: CairnSessionConfig): void {
  const { threadId, workspaceId, projectId } = config;
  const seen = new Set<string>();

  ctx.on("session/event", (session: Session, event: SessionEvent) => {
    const key = `${session.id}:${event.seq}`;
    if (seen.has(key)) return;
    seen.add(key);

    const db = getDb(ctx);
    if (!db) return;

    try {
      upsertChatThread(db, { id: threadId, scope: "workspace", workspaceId, projectId });
    } catch { /* non-fatal */ }

    if (event.type === "user/message" || event.type === "assistant/message") {
      const role = event.type === "user/message" ? "user" : "assistant";
      const content = eventText(event);
      const { reasoning, items } = eventReasoning(event);
      if (role === "assistant" && !content && !reasoning) return;
      try {
        addChatMessage(db, {
          id: newId(),
          threadId,
          role,
          content: content || "",
          reasoning: reasoning || undefined,
          reasoningItems: items,
          reasoningModel: (event.data as { message?: { source?: { model?: string } } }).message?.source?.model,
        });
      } catch { /* non-fatal */ }
    }
  });
}

// ── cairn-subagent ───────────────────────────────────────────────────────────
export interface CairnSubagentConfig {
  /** Emit a Cairn IPC event (threadId already tagged by the caller). */
  send: (channel: string, payload: Record<string, unknown>) => void;
}

/**
 * Map dsh subagent children (sessions with header.origin === 'subagent') onto
 * Cairn's `chat:subagent*` IPC vocabulary so the renderer's live subagent
 * traces work over the dsh engine. dsh subagents are general child agents with
 * their own session logs; the role label is the child's delegation label.
 */
export function cairnSubagentPlugin(ctx: Context, config: CairnSubagentConfig): void {
  const { send } = config;
  const started = new Set<string>();
  const callName = new Map<string, string>();
  // Track whether a child streamed text / reasoning as deltas, so the final
  // assistant/message doesn't re-emit the same content (which duplicated the
  // brief) and so a reasoning block never lands in the token stream (the brief).
  const streamedText = new Set<string>();
  const streamedReasoning = new Set<string>();

  ctx.on("session/event", (session: Session, event: SessionEvent) => {
    const isChild = (session as { header?: { origin?: string } }).header?.origin === "subagent";
    if (!isChild) return;

    const childId = String(session.id);
    const seq = event.seq;

    if (event.type === "user/message") {
      if (!started.has(childId)) {
        started.add(childId);
        const label = (event.data as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content
          ?.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("").slice(0, 60) ?? "subagent";
        send("chat:subagent", { status: "start", childId, role: label || "subagent", instruction: label });
      }
      return;
    }

    if (event.type === "assistant/chunk") {
      const c = (event.data as { chunk?: { type?: string; text?: string } }).chunk;
      if (!c) return;
      if (c.type === "text-delta" && c.text) { streamedText.add(childId); send("chat:subagent-token", { childId, delta: c.text }); }
      if (c.type === "reasoning-delta" && c.text) { streamedReasoning.add(childId); send("chat:subagent-thought", { childId, delta: c.text }); }
      return;
    }

    if (event.type === "tool/call") {
      const d = event.data as { name: string; arguments?: string; callId?: string };
      if (d.callId) callName.set(d.callId, d.name);
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(d.arguments ?? "{}") as Record<string, unknown>; } catch { /* keep {} */ }
      send("chat:subagent-tool-call", { childId, tool: d.name, label: d.name, callId: d.callId, args });
      return;
    }

    if (event.type === "tool/result") {
      const msg = (event.data as { message?: { source?: { callId?: string }; content?: Array<{ type?: string; isError?: boolean; content?: Array<{ type?: string; text?: string }> }> } }).message;
      const callId = msg?.source?.callId;
      const block = msg?.content?.[0];
      const isError = block?.isError === true;
      const output = block?.content?.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("") ?? "";
      const tool = callId ? (callName.get(callId) ?? "tool") : "tool";
      send("chat:subagent-tool-call-done", {
        childId, tool, callId,
        ok: !isError, error: isError ? (output || "tool error") : undefined,
        output: isError ? undefined : output,
      });
      return;
    }

    if (event.type === "assistant/message") {
      const usage = (event.data as { usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } }).usage;
      if (usage) {
        send("chat:subagent-usage", {
          childId,
          promptTokens: usage.inputTokens ?? 0,
          completionTokens: usage.outputTokens ?? 0,
          reasoningTokens: usage.reasoningTokens ?? 0,
        });
      }
      // Fill gaps ONLY: if deltas already streamed the text/reasoning, don't
      // re-emit (that duplicated the brief). Text goes to the token stream (the
      // brief); the reasoning block goes to the thought stream — never mix them,
      // or chain-of-thought leaks into the FINDINGS BRIEF.
      if (!streamedText.has(childId)) {
        const text = eventText(event);
        if (text) send("chat:subagent-token", { childId, delta: text });
      }
      if (!streamedReasoning.has(childId)) {
        const { reasoning } = eventReasoning(event);
        if (reasoning) send("chat:subagent-thought", { childId, delta: reasoning });
      }
      return;
    }

    if (event.type === "turn/end") {
      const reason = (event.data as { reason?: { kind?: string } }).reason;
      const result = reason?.kind === "completed" ? "" : ` (${reason?.kind ?? "error"})`;
      send("chat:subagent", { status: "done", childId, result, error: reason?.kind === "completed" ? undefined : reason?.kind });
      void seq;
      return;
    }
  });
}

// ── cairn-questions ───────────────────────────────────────────────────────────
export interface CairnQuestionsConfig {
  /** Emit a Cairn IPC event to the renderer (threadId tagged by the caller). */
  send: (channel: string, payload: Record<string, unknown>) => void;
  /**
   * Register a resolver for one pending question request; returns a disposer.
   * The IPC handler calls the stored resolver when the renderer answers.
   */
  registerPending: (requestId: string, resolve: (answersText: string) => void) => () => void;
  /**
   * How to surface the question form to the renderer. Chat omits this and the
   * plugin emits the `chat:tool-call` shape; the coding agent supplies one that
   * emits `pi-agent:ask-questions` (its renderer listens on a different channel).
   * Receives the requestId (echoed back on answer) + the questions.
   */
  emitQuestions?: (requestId: string, questions: CairnQuestionItem[]) => void;
  signal?: AbortSignal;
}

/** The question shape that flows through ask() — Cairn's ask_questions schema
 *  ({id,label,prompt}), which is already the renderer's PendingQuestion shape.
 *  dsh's user-questions service forwards the questions array opaquely. */
interface CairnQuestionItem { id: string; label?: string; prompt?: string }

/** dsh AskUserQuestionAnswer shape returned by the provider. */
interface DshAnswer { answers: Array<{ id: string; selected: string[]; custom?: string }> }
/** The subset of ctx.userQuestions the provider registration needs. */
interface UserQuestionsSeam {
  registerProvider: (p: { ask: (req: { questions: CairnQuestionItem[]; signal?: AbortSignal }) => Promise<DshAnswer> }) => () => void;
}

/**
 * Bridge the dsh user-questions seam (ctx.userQuestions) to Cairn's renderer
 * question form. Registers the single UI provider: ask() maps dsh questions to
 * the `ask_questions` IPC shape the renderer already renders, sends it, blocks
 * until the renderer answers (via registerPending), then maps the answer text
 * back to dsh's structured AskUserQuestionAnswer. This gives the coding agent
 * and chat a blocking, same-turn question flow without the unpublished
 * dsh-tool-ask-user package.
 */
export function cairnQuestionsPlugin(ctx: Context, config: CairnQuestionsConfig): void {
  const { send, registerPending, emitQuestions, signal } = config;
  const uq = (ctx as unknown as { userQuestions?: UserQuestionsSeam }).userQuestions;
  if (!uq) return;

  uq.registerProvider({
    ask: async (request) => {
      const requestId = `q-${newId()}`;
      // The ask_questions tool passes Cairn-shaped questions ({id,label,prompt})
      // straight through ctx.userQuestions.ask(), and that IS exactly the
      // renderer's PendingQuestion shape — so forward them UNCHANGED. (Do not
      // remap to dsh's {question,header} fields: those are undefined here and
      // would render an empty, un-fillable form.)
      const questions = request.questions;
      if (emitQuestions) {
        // Coding path: emit on the pi-agent question channel (renderer-specific).
        emitQuestions(requestId, questions);
      } else {
        // Chat path: the chat renderer picks up ask_questions as a tool-call.
        send("chat:tool-call", { tool: "ask_questions", label: `Asking ${questions.length} question${questions.length === 1 ? "" : "s"}`, callId: requestId, args: { questions } });
      }

      const answersText = await new Promise<string>((resolve) => {
        const dispose = registerPending(requestId, (text) => { dispose(); resolve(text); });
        const onAbort = () => { dispose(); resolve('{"cancelled":true,"answers":[]}'); };
        if (request.signal?.aborted || signal?.aborted) onAbort();
        request.signal?.addEventListener?.("abort", onAbort, { once: true });
        signal?.addEventListener?.("abort", onAbort, { once: true });
      });

      // The renderer answers with a JSON blob {answers:[{id,selected[],custom?}]}
      // (structured) or plain text. Map both back to dsh's answer structure.
      try {
        const parsed = JSON.parse(answersText) as { answers?: Array<{ id?: string; selected?: string[]; custom?: string }> };
        if (Array.isArray(parsed.answers)) {
          return { answers: parsed.answers.map((a, i) => ({ id: a.id ?? request.questions[i]?.id ?? String(i), selected: a.selected ?? [], custom: a.custom })) };
        }
      } catch { /* fall through to plain-text */ }
      return { answers: request.questions.map((q, i) => ({ id: q.id, selected: [], custom: i === 0 ? answersText : undefined })) };
    },
  });
}
// Cordis gates ctx.userQuestions behind an explicit injection declaration.
cairnQuestionsPlugin.inject = ["userQuestions"];

// ── cairn-usage ─────────────────────────────────────────────────────────────
export interface CairnUsageConfig {
  threadId: string;
  workspaceId: string;
  projectId?: string;
  provider?: string;
  model: string;
  baseUrl?: string;
}

/** Record token/cost usage from dsh usage chunks into Cairn's llm_usage table. */
export function cairnUsagePlugin(ctx: Context, config: CairnUsageConfig): void {
  const { threadId, workspaceId, projectId, provider, model, baseUrl } = config;
  let prompt = 0;
  let completion = 0;
  let reasoning = 0;

  ctx.on("session/event", (_session: Session, event: SessionEvent) => {
    if (event.type !== "assistant/chunk") return;
    const chunk = (event.data as { chunk?: { type?: string; usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } } }).chunk;
    if (chunk?.type !== "usage" || !chunk.usage) return;

    prompt = Math.max(prompt, chunk.usage.inputTokens ?? 0);
    completion += chunk.usage.outputTokens ?? 0;
    reasoning += chunk.usage.reasoningTokens ?? 0;

    recordLlmUsage({
      source: "chat",
      sessionId: threadId,
      projectId,
      workspaceId,
      provider,
      model,
      baseUrl,
      promptTokens: prompt,
      completionTokens: completion,
      reasoningTokens: reasoning,
    });
  });
}

// ── cairn-coding ──────────────────────────────────────────────────────────────
// Bridge the MAIN coding session's dsh events onto Cairn's `pi-agent:*` IPC
// vocabulary so the renderer's AgentChatPane works unchanged over the Cordis
// engine (Phase 1.5 step 2b). Sibling to cairnSubagentPlugin (which handles
// child `origin:'subagent'` sessions); this one owns the parent session's
// token/thought/tool/usage/step/done/error stream plus the note-updated / todos
// / plan-note side effects. It is scoped to a single parent sessionId and
// ignores subagent children (those are bridged by cairnSubagentPlugin).

export interface CairnCodingConfig {
  /** The parent coding session id — scopes every emitted event (the caller's id). */
  sessionId: string;
  /**
   * The dsh session id to MATCH events against (the loop's attempt session id).
   * Separate from `sessionId` because the loop mints a fresh dsh id per attempt.
   */
  matchSessionId: string;
  /** Current agent mode — drives plan-note detection. */
  mode: "plan" | "execute";
  /** Emit a `pi-agent:*` IPC event to the renderer (sessionId NOT yet tagged). */
  send: (channel: string, payload: Record<string, unknown>) => void;
  /** Resolve/abort when the parent turn completes — used by the loop await. */
  signal?: AbortSignal;
}

/** The dsh `todo/write` snapshot payload (TodoItem[]). */
interface DshTodoWrite {
  todos?: Array<{ content: string; status: string }>;
}

/**
 * Map the parent coding session's `session/event` stream to `pi-agent:*` events.
 * Mirrors the built-in runSession() wiring in electron/ipc/pi-agent.ts, but
 * driven entirely from dsh events (the dsh agent loop runs the model↔tools loop
 * internally — we only translate what it emits).
 *
 * Emitted channels (payloads match the built-in contract exactly):
 *   pi-agent:token/{delta}, pi-agent:thought/{delta},
 *   pi-agent:usage/{promptTokens,completionTokens,reasoningTokens},
 *   pi-agent:tools-ready/{}, pi-agent:tool/{name,label,args,callId,status,ok,output},
 *   pi-agent:step/{}, pi-agent:done/{}, pi-agent:error/{error},
 *   pi-agent:note-updated/{noteId,content}, pi-agent:todos/{todos},
 *   pi-agent:plan-note/{noteId}
 *
 * Token/reasoning deltas are streamed live; the final assistant/message only
 * fills gaps (never re-emits streamed content — same guard as cairnSubagentPlugin).
 */
export function cairnCodingPlugin(ctx: Context, config: CairnCodingConfig): void {
  const { sessionId, matchSessionId, mode, send, signal } = config;

  // Track per-callId tool names (parallel calls to different tools resolve by callId).
  const callName = new Map<string, string>();
  const callLabel = new Map<string, string>();
  // Set when the first tool/call of the session is seen — emit tools-ready once.
  let toolsReadyFired = false;
  // Whether we've seen a turn/start past the first (dsh emits one per step).
  let firstTurnStarted = false;
  // Delays: streamed deltas must not be re-emitted by the final assistant/message.
  const streamedText = new Set<string>();
  const streamedReasoning = new Set<string>();
  // Terminal-guard: emit done/error exactly once per turn.
  let ended = false;
  // Latest compaction summary text, captured on compaction/summary and reported
  // to the renderer on compaction/end (auto-compaction is step-boundary driven).
  let lastCompactSummary = "";
  let lastCompactCount = 0;

  const emit = (channel: string, payload: Record<string, unknown>) => send(channel, { sessionId, ...payload });

  const finish = (kind: "done" | "error", error?: string) => {
    if (ended) return;
    ended = true;
    if (kind === "done") emit("pi-agent:done", {});
    else emit("pi-agent:error", { error: error ?? "Agent error" });
  };
  if (signal?.aborted) finish("done");

  ctx.on("session/event", (session: Session, event: SessionEvent) => {
    // Only the parent session (this loop's dsh attempt id) — children are bridged
    // by cairnSubagentPlugin.
    if (String((session as { id?: unknown }).id) !== matchSessionId) return;
    const seq = event.seq;

    // ── Step boundary ────────────────────────────────────────────────────────
    // dsh opens a durable turn per step. The builtin fires onStepStart for every
    // step after the first so the renderer finalises the previous assistant
    // message. Map the first turn/start as tools/stream start and later ones as
    // step boundaries.
    if (event.type === "turn/start") {
      if (!firstTurnStarted) firstTurnStarted = true;
      else emit("pi-agent:step", {});
      return;
    }

    // ── Token / reasoning deltas ─────────────────────────────────────────────
    if (event.type === "assistant/chunk") {
      const c = (event.data as { chunk?: { type?: string; text?: string; usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } } }).chunk;
      if (!c) return;
      if (c.type === "text-delta" && c.text) {
        streamedText.add(sessionId);
        emit("pi-agent:token", { delta: c.text });
        return;
      }
      if (c.type === "reasoning-delta" && c.text) {
        streamedReasoning.add(sessionId);
        emit("pi-agent:thought", { delta: c.text });
        return;
      }
      if (c.type === "usage" && c.usage) {
        emit("pi-agent:usage", {
          promptTokens: c.usage.inputTokens ?? 0,
          completionTokens: c.usage.outputTokens ?? 0,
          reasoningTokens: c.usage.reasoningTokens ?? 0,
        });
        return;
      }
      return;
    }

    // ── Tool call (model's request, before execution) ────────────────────────
    if (event.type === "tool/call") {
      if (!toolsReadyFired) {
        toolsReadyFired = true;
        emit("pi-agent:tools-ready", {});
      }
      const d = event.data as { name: string; arguments?: string; callId?: string };
      if (d.callId) callName.set(d.callId, d.name);
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(d.arguments ?? "{}") as Record<string, unknown>; } catch { /* keep {} */ }
      const callId = d.callId ?? `${d.name}:${seq}`;
      const label = d.name;
      callLabel.set(callId, label);
      // "pending" chip (same as builtin onToolPending) — frontend treats it as a
      // running chip immediately, matching the streaming pending-state UX.
      emit("pi-agent:tool", { name: d.name, label, args, callId, status: "pending" });
      return;
    }

    // ── Tool result (after execution) ────────────────────────────────────────
    if (event.type === "tool/result") {
      const msg = (event.data as { message?: { source?: { callId?: string }; content?: Array<{ type?: string; isError?: boolean; content?: Array<{ type?: string; text?: string }> }> } }).message;
      const callId = msg?.source?.callId;
      const block = msg?.content?.[0];
      const isError = block?.isError === true;
      const output = block?.content?.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("") ?? "";
      const name = callId ? (callName.get(callId) ?? "tool") : "tool";
      const label = callId ? (callLabel.get(callId) ?? name) : name;
      // ok = !isError and not a Cairn `{error:…}` return (same detection as builtin).
      const ok = !isError && resultContentError(output) === undefined;
      emit("pi-agent:tool", {
        name, label, callId, status: "end", ok,
        output: isError ? undefined : output,
        args: undefined,
      });

      // ── note-updated: after a note-write tool, push fresh note content so the
      // plan task list updates live (mirrors builtin NOTE_WRITE_TOOLS handling).
      const db = getDb(ctx);
      if (ok && db && ["ensure_note", "patch_note", "append_to_note"].includes(name)) {
        try {
          const parsed = JSON.parse(output) as { id?: string };
          if (parsed?.id) {
            const row = db.prepare("SELECT content FROM notes WHERE id = ?").get(parsed.id) as { content: string } | undefined;
            if (row) emit("pi-agent:note-updated", { noteId: parsed.id, content: row.content ?? "" });
          }
        } catch { /* non-JSON output — ignore */ }
      }

      // ── plan-note: in plan mode, notify the renderer when the agent writes the PRD note.
      if (mode === "plan" && ok && name === "ensure_note") {
        try {
          const parsed = JSON.parse(output) as { id?: string };
          if (parsed?.id) emit("pi-agent:plan-note", { noteId: parsed.id });
        } catch { /* non-JSON output — ignore */ }
      }

      // ── todos: the dsh `todo_write` tool writes `todo/write` snapshots; map
      // the latest to Cairn's pi_session_todos + emit pi-agent:todos.
      if (name === "todo_write" && db) {
        try {
          const parsed = JSON.parse(output) as DshTodoWrite;
          const list = Array.isArray(parsed.todos)
            ? parsed.todos.map((t) => ({
                content: t.content,
                status: (t.status === "in_progress" || t.status === "completed" || t.status === "pending" ? t.status : "pending") as "pending" | "in_progress" | "completed",
                priority: "medium" as const,
              }))
            : [];
          saveSessionTodos(db, sessionId, list);
          emit("pi-agent:todos", { todos: getSessionTodos(db, sessionId) });
        } catch { /* non-critical */ }
      }
      return;
    }

    // ── Final assistant message: fill text/reasoning gaps only ───────────────
    if (event.type === "assistant/message") {
      if (!streamedText.has(sessionId)) {
        const text = eventText(event);
        if (text) emit("pi-agent:token", { delta: text });
      }
      if (!streamedReasoning.has(sessionId)) {
        const { reasoning } = eventReasoning(event);
        if (reasoning) emit("pi-agent:thought", { delta: reasoning });
      }
      return;
    }

    // ── Retry: dsh-llm-retry records a durable llm/retry before each wait ─────
    if (event.type === "llm/retry") {
      const d = event.data as { retry?: number; maxRetries?: number; delayMs?: number; failure?: { message?: string; code?: string } };
      emit("pi-agent:retry", {
        attempt: (d.retry ?? 0) + 1,
        maxRetries: d.maxRetries ?? 0,
        delayMs: d.delayMs ?? 0,
        error: d.failure?.message ?? d.failure?.code ?? "Model request failed",
      });
      return;
    }

    // ── Compaction: BasicCompactionEngine auto-compacts at 80% context ────────
    if (event.type === "compaction/start") {
      emit("pi-agent:compact", { status: "start" });
      return;
    }
    if (event.type === "compaction/summary") {
      // Remember the latest summary text + replaced-node count so compaction/end
      // can report them (compaction/end carries only lifecycle data).
      const d = event.data as { summary?: unknown; shadowedSeqs?: unknown[] };
      const s = d.summary;
      lastCompactSummary = typeof s === "string" ? s : (Array.isArray(s) ? s.filter((b) => (b as { type?: string }).type === "text").map((b) => (b as { text?: string }).text ?? "").join("") : "");
      lastCompactCount = Array.isArray(d.shadowedSeqs) ? d.shadowedSeqs.length : 0;
      return;
    }
    if (event.type === "compaction/end") {
      // A failed close records an `error` on the end marker — don't claim success.
      const failed = (event.data as { error?: unknown }).error !== undefined;
      emit("pi-agent:compact", { status: "end", auto: true });
      if (!failed) {
        emit("pi-agent:compact-result", { messageCount: lastCompactCount, summary: lastCompactSummary });
      }
      lastCompactSummary = "";
      lastCompactCount = 0;
      return;
    }

    // ── Turn end: map completion to done/error ───────────────────────────────
    // A user turn is multiple steps (LLM → tool → LLM → tool → answer).
    // Only the final turn/end is "completed"; intermediate steps surface as
    // `step/end`, and a turn that ends for any other terminal reason (aborted,
    // blocked, error, max-tokens) is the failure case. Do NOT treat a
    // non-completed turn as an error while steps are still in flight — the
    // loop will keep stepping until it truly completes.
    if (event.type === "turn/end") {
      const reason = (event.data as { reason?: { kind?: string } }).reason?.kind;
      if (reason === "completed") finish("done");
      else if (reason === "aborted" || reason === "blocked" || reason === "error" || reason === "max-tokens") {
        finish("error", reason ? `Agent turn ended abnormally (${reason})` : "Agent turn ended abnormally");
      }
      return;
    }
  });
}

// ── cairn-plan-mode ──────────────────────────────────────────────────────────
// Plan-mode read-only gate for the coding agent (Phase 1.5 step 2d). dsh's
// dsh-plan-mode provides the logged plan/mode state + the exit_plan_mode review
// tool, but it does NOT restrict the toolset. This plugin registers a
// tools/pre-execute guard that DENIES mutating tools while plan mode is active,
// mirroring Cairn's builtin PLAN_MODE_ALLOWED contract: plan mode is read-only
// analysis + writing the PRD note (ensure_note) only.

/** Tools permitted while plan mode is active (read-only + PRD write). */
const PLAN_MODE_ALLOWED = new Set<string>([
  // Coding read-only (dsh names).
  "read", "read_image", "glob", "grep",
  // Plan-mode control (dsh).
  "exit_plan_mode", "plan",
  // Cairn read / context.
  "get_active_context", "get_project_context_pack", "get_user_writing_style",
  "get_note", "search_notes", "search_notes_semantic", "search_tasks_semantic",
  "get_task", "search_tasks", "list_ready_tasks", "list_overdue_tasks",
  "list_tasks_due", "list_templates",
  "codebase_search_symbols", "codebase_get_symbol_definition",
  "codebase_get_references", "codebase_get_file_symbols",
  // Cairn write — PRD note only (idempotent upsert).
  "ensure_note",
  // Renderer-side questions + skills.
  "ask_questions", "skill",
]);

export interface CairnPlanModeConfig {
  /** Whether plan mode is active for this turn. */
  active: boolean;
}

/**
 * Gate mutating tools out of plan mode. Registers a `tools/pre-execute` handler
 * that returns `{kind:'deny'}` for any tool not in PLAN_MODE_ALLOWED while plan
 * mode is active. Read-only + ensure_note + exit_plan_mode pass through.
 */
export function cairnPlanModePlugin(ctx: Context, config: CairnPlanModeConfig): (() => void) | void {
  const { active } = config;
  if (!active) return;

  // Register on the tools pre-execute waterfall. The first denial reason is
  // surfaced to the model so it knows why the call was blocked.
  const unsub = (ctx as unknown as { on: (ev: string, fn: (...args: unknown[]) => unknown) => () => void }).on(
    "tools/pre-execute",
    (...args: unknown[]) => {
      const exec = args[0] as { name?: string } | undefined;
      const next = args[1] as (() => Promise<unknown>) | undefined;
      const name = exec?.name;
      if (typeof name === "string" && !PLAN_MODE_ALLOWED.has(name)) {
        return Promise.resolve({ kind: "deny", reason: `"${name}" is not available in plan mode (read-only).` });
      }
      return next ? next() : undefined;
    },
  );
  return unsub;
}

// ── cairn-approval ────────────────────────────────────────────────────────────
// Human-in-the-loop tool approval for the coding agent (Phase 1.5 step 2e).
// When autoApprove is OFF, mutating tools must be confirmed by the user before
// they run. dsh's approval seam (ctx.approval) + tools pipeline provide the
// mechanism: a `tools/pre-execute` handler returns {kind:'ask'} for a mutating
// tool, the pipeline calls ctx.approval.request, and this plugin's answerer
// bridges that to Cairn's renderer confirm UI (pi-agent:tool-confirm-required ⇄
// pi-agent:respond-tool). Read-only tools always pass (never ask).

/** Tools that never need approval (read-only / safe). */
const APPROVAL_SAFE = new Set<string>([
  "read", "read_image", "glob", "grep", "plan", "exit_plan_mode",
  "get_active_context", "get_project_context_pack", "get_user_writing_style",
  "get_note", "search_notes", "search_notes_semantic", "search_tasks_semantic",
  "get_task", "search_tasks", "list_ready_tasks", "list_overdue_tasks",
  "list_tasks_due", "list_templates", "get_neighbors", "get_idea_flow",
  "get_idea_flow_rules",
  "codebase_search_symbols", "codebase_get_symbol_definition",
  "codebase_get_references", "codebase_get_file_symbols",
  "ask_questions", "skill",
]);

export interface CairnApprovalConfig {
  /** When true, every tool runs without a confirm prompt (no asks). */
  autoApprove: boolean;
  /** The caller's pi sessionId — scopes the confirm IPC. */
  sessionId: string;
  /** Emit a `pi-agent:*` IPC event (sessionId NOT yet tagged). */
  send: (channel: string, payload: Record<string, unknown>) => void;
  /**
   * Register a resolver for one pending approval, keyed by callId; returns a
   * disposer. The pi-agent:respond-tool IPC handler invokes the resolver with
   * the user's decision.
   */
  registerPending: (callId: string, resolve: (decision: { approved: boolean; grant?: "session" | "command" }) => void) => () => void;
  signal?: AbortSignal;
}

/**
 * Bridge dsh's approval seam to Cairn's renderer confirm UI. Mounted per turn.
 * No-op when autoApprove is true. Otherwise:
 *   1. tools/pre-execute → {kind:'ask'} for any non-safe tool (mutating).
 *   2. approval/request answerer → emit pi-agent:tool-confirm-required, block on
 *      pi-agent:respond-tool, map to allowed-once / rejected.
 * A session-grant (grant:'session') is remembered so the same tool isn't
 * re-prompted for the rest of the turn.
 */
export function cairnApprovalPlugin(ctx: Context, config: CairnApprovalConfig): (() => void) | void {
  const { autoApprove, sessionId, send, registerPending, signal } = config;
  if (autoApprove) return;

  const disposers: Array<() => void> = [];
  // Tools the user granted for the whole session — skip re-prompting.
  const sessionGranted = new Set<string>();

  // 1) Ask-trigger: mutating tools route to the approval seam.
  const unsubPre = (ctx as unknown as { on: (ev: string, fn: (...args: unknown[]) => unknown) => () => void }).on(
    "tools/pre-execute",
    (...args: unknown[]) => {
      const exec = args[0] as { name?: string } | undefined;
      const next = args[1] as (() => Promise<unknown>) | undefined;
      const name = exec?.name;
      if (typeof name === "string" && !APPROVAL_SAFE.has(name) && !sessionGranted.has(name)) {
        return Promise.resolve({ kind: "ask", reason: `"${name}" needs your approval before it runs.` });
      }
      return next ? next() : undefined;
    },
  );
  disposers.push(unsubPre);

  // 2) Answerer: bridge the ask to the renderer confirm UI.
  const unsubAns = (ctx as unknown as { on: (ev: string, fn: (...args: unknown[]) => unknown) => () => void }).on(
    "approval/request",
    (...args: unknown[]) => {
      const req = args[0] as { toolName?: string; callId?: string; reason?: string; signal?: AbortSignal } | undefined;
      const toolName = req?.toolName ?? "tool";
      const callId = req?.callId ?? `approve-${newId()}`;
      if (sessionGranted.has(toolName)) return Promise.resolve("allowed-once");
      send("pi-agent:tool-confirm-required", { sessionId, name: toolName, label: toolName, callId });
      return new Promise<string>((resolve) => {
        const dispose = registerPending(callId, (decision) => {
          dispose();
          if (decision.approved && decision.grant === "session") sessionGranted.add(toolName);
          resolve(decision.approved ? "allowed-once" : "rejected");
        });
        const onAbort = () => { dispose(); resolve("cancelled"); };
        if (req?.signal?.aborted || signal?.aborted) onAbort();
        req?.signal?.addEventListener?.("abort", onAbort, { once: true });
        signal?.addEventListener?.("abort", onAbort, { once: true });
      });
    },
  );
  disposers.push(unsubAns);

  return () => { for (const d of disposers) { try { d(); } catch { /* noop */ } } };
}

// ── cairn-doom-loop ───────────────────────────────────────────────────────────
// Detect a stuck agent repeating the SAME tool with IDENTICAL arguments and
// pause for a user decision before it burns the step budget (Phase 1.5 step 2f).
// Reuses the builtin toolCallSignature + DOOM_LOOP_THRESHOLD. Implemented as a
// tools/pre-execute guard: when the last (THRESHOLD-1) calls all match this
// call's signature, emit pi-agent:doom-loop and block on respond-doom-loop —
// allow → run + stop re-pausing this session; deny → deny the call.

export interface CairnDoomLoopConfig {
  /** The caller's pi sessionId — scopes the doom-loop IPC + pending key. */
  sessionId: string;
  /** Emit a `pi-agent:*` IPC event (sessionId NOT yet tagged). */
  send: (channel: string, payload: Record<string, unknown>) => void;
  /**
   * Register a resolver for one pending doom-loop decision, keyed by callId
   * (`${sessionId}:${signature}`); returns a disposer. pi-agent:respond-doom-loop
   * invokes the resolver with the user's allow/deny.
   */
  registerPending: (callId: string, resolve: (allow: boolean) => void) => () => void;
  signal?: AbortSignal;
}

export function cairnDoomLoopPlugin(ctx: Context, config: CairnDoomLoopConfig): (() => void) | void {
  const { sessionId, send, registerPending, signal } = config;
  const recent: string[] = [];
  let approved = false; // once the user allows, stop re-pausing this session

  const unsub = (ctx as unknown as { on: (ev: string, fn: (...args: unknown[]) => unknown) => () => void }).on(
    "tools/pre-execute",
    async (...args: unknown[]) => {
      const exec = args[0] as { name?: string; arguments?: unknown } | undefined;
      const next = args[1] as (() => Promise<unknown>) | undefined;
      const name = exec?.name;
      if (typeof name !== "string") return next ? next() : undefined;

      const argsObj = (exec?.arguments && typeof exec.arguments === "object") ? exec.arguments as Record<string, unknown> : {};
      const sig = toolCallSignature(name, argsObj);

      if (!approved) {
        const window = recent.slice(-(DOOM_LOOP_THRESHOLD - 1));
        if (window.length === DOOM_LOOP_THRESHOLD - 1 && window.every((s) => s === sig)) {
          const callId = `${sessionId}:${sig}`;
          send("pi-agent:doom-loop", { sessionId, toolName: name, count: DOOM_LOOP_THRESHOLD, args: argsObj, callId });
          const allow = await new Promise<boolean>((resolve) => {
            const dispose = registerPending(callId, (a) => { dispose(); resolve(a); });
            const onAbort = () => { dispose(); resolve(false); };
            if (signal?.aborted) onAbort();
            signal?.addEventListener?.("abort", onAbort, { once: true });
          });
          // Track the attempted signature regardless.
          recent.push(sig);
          if (recent.length > DOOM_LOOP_THRESHOLD) recent.shift();
          if (!allow) return { kind: "deny", reason: "Stopped: repeated identical tool call (possible loop). Halted by the user." };
          approved = true;
          return next ? next() : undefined;
        }
      }
      recent.push(sig);
      if (recent.length > DOOM_LOOP_THRESHOLD) recent.shift();
      return next ? next() : undefined;
    },
  );
  return unsub;
}
