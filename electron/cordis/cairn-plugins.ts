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
import { upsertChatThread } from "../db/queries";
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
// See electron/cordis/ctx-augment.ts — same augmentation load.
import "./ctx-augment";
import { recordLlmUsage } from "../lib/usage-recorder";
import { newId } from "../db/utils";
import { saveSessionTodos, getSessionTodos, updateCodingSession } from "../db/queries";
import { resultContentError } from "../lib/tool-result";
import { getSessionGrants, canonicalBashCommand, recordPendingApprovalArgs, forgetPendingApprovalArgs } from "./approval-grants";
import { APPROVAL_SAFE_TOOLS } from "../../shared/agent/tool-risk";

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
let activeSystemText = "";

export function updateSystemPrompt(text: string): void {
  activeSystemText = text;
}

export function cairnSystemPromptPlugin(ctx: Context, config: CairnSystemPromptConfig): (() => void) | void {
  const { systemText } = config;
  if (systemText) activeSystemText = systemText;

  const sp = ctx.systemPrompt;
  if (!sp || typeof sp.section !== "function") return;

  return sp.section({
    name: "cairn:system",
    order: -100,
    text: () => activeSystemText,
  });
}
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
  const existing = ctx.get(CAIRN_DB);
  if (existing) return;
  return ctx.provide(CAIRN_DB, config.db);
}

function getDb(ctx: Context): Database.Database | undefined {
  return ctx.get(CAIRN_DB) as Database.Database | undefined;
}

// ── cairn-session ───────────────────────────────────────────────────────────
export interface CairnSessionConfig {
  threadId: string;
  workspaceId: string;
  projectId?: string;
}

/** Extract the plain-text content of a message event. Handles both the
 *  `data.message.content` shape (assistant/message) and the `data.content`
 *  shape (user/message on the live session/event stream, where content sits
 *  directly on data — the previous data.message.content read returned "" for
 *  user messages, so a subagent's instruction fell back to "subagent"). */
function eventText(event: SessionEvent): string {
  const d = event.data as { message?: { content?: Array<{ type: string; text?: string }> }; content?: Array<{ type: string; text?: string }> };
  const content = d.message?.content ?? d.content;
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("");
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

/** Index a dsh session's thread in SQLite; messages live in the JSONL log (not `chat_messages`).
 *
 *  Previously this also duplicated every `user/message`/`assistant/message` into
 *  `chat_messages` (and `useChatStream onDone` did the same), causing the
 *  `rSle/Hwx 171ms` double-final and `GpKH` reasoning-only ghost. `chat_messages`
 *  is now legacy — the session log (`JsonlSessionPersistence` `chat-<threadId>`)
 *  is the durable transcript and `db:chat:sessionMessages` reads it directly.
 *  This plugin only maintains the lightweight `chat_threads` index for the thread
 *  list; message history is never written to SQLite here.
 */
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
    const header = (session as { header?: { origin?: string; parentSession?: unknown } }).header;
    const isChild = header?.origin === "subagent";
    if (!isChild) return;

    const childId = String(session.id);
    // Parent session id (the calling chat thread OR coding-agent session).
    // Included in every emitted event so the renderer can filter events for
    // the pane it drives — historically this was omitted, and AgentChatPane
    // fell back to a `${sessionId}:sub:` prefix scheme that nothing emitted,
    // making every coding-agent subagent trace unreachable at runtime.
    const parentSession = header?.parentSession != null ? String(header.parentSession) : undefined;
    const seq = event.seq;

    if (event.type === "user/message") {
      // The child's first non-snapshot user/message is the delegated prompt.
      // Skip the runtime-context snapshot (form:snapshot) so the instruction is
      // the actual task, not "Current runtime context…". Use eventText (handles
      // both data.message.content and data.content shapes) — the previous inline
      // read of data.message.content returned undefined for the append-surface
      // shape, so the instruction fell back to "subagent".
      const src = (event.data as { message?: { source?: { kind?: string; form?: string } }; source?: { kind?: string; form?: string } }).message?.source
        ?? (event.data as { source?: { kind?: string; form?: string } }).source;
      if (src?.kind === "plugin" && src?.form === "snapshot") return;
      if (!started.has(childId)) {
        started.add(childId);
        const full = eventText(event).trim();
        const instruction = full || "subagent";
        const role = full ? full.slice(0, 60) : "subagent";
        send("chat:subagent", { status: "start", childId, parentSession, role, instruction });
      }
      return;
    }

    if (event.type === "assistant/chunk") {
      const c = (event.data as { chunk?: { type?: string; text?: string } }).chunk;
      if (!c) return;
      if (c.type === "text-delta" && c.text) { streamedText.add(childId); send("chat:subagent-token", { childId, parentSession, delta: c.text }); }
      if (c.type === "reasoning-delta" && c.text) { streamedReasoning.add(childId); send("chat:subagent-thought", { childId, parentSession, delta: c.text }); }
      return;
    }

    if (event.type === "tool/call") {
      const d = event.data as { name: string; arguments?: string; callId?: string };
      if (d.callId) callName.set(d.callId, d.name);
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(d.arguments ?? "{}") as Record<string, unknown>; } catch { /* keep {} */ }
      send("chat:subagent-tool-call", { childId, parentSession, tool: d.name, label: d.name, callId: d.callId, args });
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
        childId, parentSession, tool, callId,
        ok: !isError, error: isError ? (output || "tool error") : undefined,
        output: isError ? undefined : output,
      });
      return;
    }

    if (event.type === "assistant/message") {
      const usage = (event.data as { usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } }).usage;
      if (usage) {
        send("chat:subagent-usage", {
          childId, parentSession,
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
        if (text) send("chat:subagent-token", { childId, parentSession, delta: text });
      }
      if (!streamedReasoning.has(childId)) {
        const { reasoning } = eventReasoning(event);
        if (reasoning) send("chat:subagent-thought", { childId, parentSession, delta: reasoning });
      }
      return;
    }

    if (event.type === "turn/end") {
      const reason = (event.data as { reason?: { kind?: string } }).reason;
      const result = reason?.kind === "completed" ? "" : ` (${reason?.kind ?? "error"})`;
      send("chat:subagent", { status: "done", childId, parentSession, result, error: reason?.kind === "completed" ? undefined : reason?.kind });
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
  /** Fail-closed idle timeout for the form. Defaults to APPROVAL_TIMEOUT_MS. */
  questionsTimeoutMs?: number;
}

/** The question shape that flows through ask() — Cairn's ask_questions schema
 *  ({id,label,prompt}), which is already the renderer's PendingQuestion shape.
 *  dsh's user-questions service forwards the questions array opaquely. */
/**
 * A pending question forwarded to the renderer. Two shapes are accepted so
 * both Cairn's own `ask_questions` tool (which emits `{id, label, prompt}`)
 * AND any dsh-native provider (dsh-plan-mode's `exit_plan_mode` uses
 * `AskUserQuestionItem = {id, question, header?, detail?, options?, intent?}`,
 * where `detail` carries the FULL markdown plan for plan-review) render as
 * a filled-in form. Previously we only forwarded Cairn's shape and dsh's
 * plan-review card came through empty and unapprovable.
 */
interface CairnQuestionItem {
  id: string;
  /** Cairn shape */
  label?: string;
  prompt?: string;
  /** dsh AskUserQuestionItem shape — see dsh-user-questions/lib/types/types.d.ts. */
  question?: string;
  header?: string;
  detail?: string;
  options?: ReadonlyArray<string | { label: string; description?: string }>;
  multiSelect?: boolean;
  intent?: { kind?: string; approve?: string; [k: string]: unknown };
}

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
export function cairnQuestionsPlugin(ctx: Context, config: CairnQuestionsConfig): (() => void) | void {
  const { send, registerPending, emitQuestions, signal, questionsTimeoutMs } = config;
  // ctx.userQuestions is provided by dsh-user-questions (see ctx-augment).
  // Cast the value through UserQuestionsSeam so Cairn's own dispose-and-
  // re-register helpers keep their local shape without leaking dsh's
  // AskUserQuestionItem into every callsite.
  const uq = ctx.userQuestions as unknown as UserQuestionsSeam | undefined;
  if (!uq) return;

  // registerProvider throws DUPLICATE_PROVIDER if a prior turn's provider fiber
  // hasn't been disposed yet (mount disposal is fire-and-forget, so a back-to-back
  // turn can re-mount before teardown settles). A duplicate registration crashes
  // the whole loop mid-turn (the "a user-questions provider is already registered"
  // abort that left the subagent stuck "Working…"). Track the disposer on the
  // shared context so we can dispose any stale provider before re-registering,
  // making the mount idempotent.
  const holder = ctx as unknown as { __cairnQuestionsDispose?: () => void };
  if (typeof holder.__cairnQuestionsDispose === "function") {
    try { holder.__cairnQuestionsDispose(); } catch { /* stale */ }
    holder.__cairnQuestionsDispose = undefined;
  }

  let providerDispose: (() => void) | undefined;
  try {
    providerDispose = uq.registerProvider({
      ask: async (request) => {
        const requestId = `q-${newId()}`;
        // Forward the raw question objects to the renderer unchanged. The
        // renderer's QuestionForm now understands BOTH the Cairn shape
        // ({id, label, prompt}) and dsh's AskUserQuestionItem shape
        // ({id, question, header?, options?, intent?}), so a payload from
        // Cairn's own ask_questions tool AND one from a dsh-native provider
        // (e.g. dsh-plan-mode's exit_plan_mode) both render as filled-in
        // forms. This closes the review's plan-mode-blank-form bug.
        const questions = request.questions;
        if (emitQuestions) {
          // Coding path: emit on the pi-agent question channel (renderer-specific).
          emitQuestions(requestId, questions);
        } else {
          // Chat path: the chat renderer picks up ask_questions as a tool-call.
          send("chat:tool-call", { tool: "ask_questions", label: `Asking ${questions.length} question${questions.length === 1 ? "" : "s"}`, callId: requestId, args: { questions } });
        }

        const answersText = await new Promise<string>((resolve) => {
          const onAborts: Array<() => void> = [];
          let settled = false;
          // Hoist the timer binding so settle() can clearTimeout(timer) even
          // when called from the synchronous-replay path below — a const
          // declaration at the tail would be in TDZ during a sync replay.
          // eslint-disable-next-line prefer-const -- reassigned at end of block; declaration must precede settle() to avoid TDZ during sync replay.
          let timer: ReturnType<typeof setTimeout> | undefined;
          // Synchronous-resolve safety — see the identical pattern in the
          // approval answerer below for the full rationale. Buffer the
          // outcome + replay after registerPending returns so dispose runs.
          const disposeRef: { current: (() => void) | null } = { current: null };
          let syncOutcome: string | null = null;
          const settle = (text: string) => {
            if (settled) return;
            if (disposeRef.current === null && syncOutcome === null) {
              syncOutcome = text;
              return;
            }
            settled = true;
            clearTimeout(timer);
            disposeRef.current?.();
            for (const off of onAborts) off();
            resolve(text);
          };
          disposeRef.current = registerPending(requestId, (text) => settle(text));
          if (syncOutcome !== null && !settled) {
            const captured = syncOutcome;
            syncOutcome = null;
            settle(captured);
          }
          const onAbort = () => settle('{"cancelled":true,"answers":[]}');
          if (request.signal?.aborted || signal?.aborted) onAbort();
          for (const sig of [request?.signal, signal]) {
            if (!sig) continue;
            sig.addEventListener?.("abort", onAbort, { once: true });
            onAborts.push(() => sig.removeEventListener?.("abort", onAbort));
          }
          // Same fail-closed budget as approvals: an unanswered form must not
          // block the loop forever. No expiry IPC needed — the loop settles
          // with the cancelled answers and the pane clears its state on done.
          timer = setTimeout(() => settle('{"cancelled":true,"answers":[]}'), questionsTimeoutMs ?? APPROVAL_TIMEOUT_MS);
        });

        // The renderer answers with a JSON blob {answers:[{id,selected[],custom?}]}
        // (structured) or plain text. Map both back to dsh's answer structure.
        //
        // Two special sentinels the renderer can send:
        //   { __dismissed__: true } — the user closed the question without
        //     answering (Discuss button on plan-review, or aborted the pane).
        //     Throw UserQuestionError with code 'ASK_CANCELLED' so
        //     dsh-plan-mode's `exit_plan_mode` reports "user dismissed to
        //     speak instead" instead of "user chose to keep planning".
        //   { cancelled: true, answers: [] } — legacy shape emitted on the
        //     turn-abort / timeout paths; treated as an empty answer batch
        //     (dsh maps that to a generic decline / keep-planning).
        try {
          const parsed = JSON.parse(answersText) as { answers?: Array<{ id?: string; selected?: string[]; custom?: string }>; __dismissed__?: boolean; cancelled?: boolean };
          if (parsed?.__dismissed__ === true) {
            throw new UserQuestionError(
              "ask_user_question was dismissed by the user",
              "ASK_CANCELLED",
            );
          }
          if (Array.isArray(parsed.answers)) {
            return { answers: parsed.answers.map((a, i) => ({ id: a.id ?? request.questions[i]?.id ?? String(i), selected: a.selected ?? [], custom: a.custom })) };
          }
        } catch (err) {
          // Re-throw UserQuestionError so plan-mode's dismiss handling fires.
          // Any other parse error falls through to plain-text treatment below.
          if (err instanceof UserQuestionError) throw err;
        }
        return { answers: request.questions.map((q, i) => ({ id: q.id, selected: [], custom: i === 0 ? answersText : undefined })) };
      },
    }) as unknown as (() => void) | undefined;
  } catch (err) {
    // If a stale provider is still registered (dispose race), swallow the
    // duplicate so the turn proceeds without ask_questions rather than aborting
    // the whole loop (the DUPLICATE_PROVIDER crash).
    if ((err as { code?: string })?.code !== "DUPLICATE_PROVIDER") throw err;
    return;
  }

  holder.__cairnQuestionsDispose = () => {
    try { providerDispose?.(); } catch { /* noop */ }
    if (holder.__cairnQuestionsDispose) holder.__cairnQuestionsDispose = undefined;
  };
  return holder.__cairnQuestionsDispose;
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

/** Record token/cost usage from dsh usage chunks and messages into Cairn's llm_usage table. */
export function cairnUsagePlugin(ctx: Context, config: CairnUsageConfig): void {
  const { threadId, workspaceId, projectId, provider, model, baseUrl } = config;
  let prompt = 0;
  let completion = 0;
  let reasoning = 0;
  let recordedInTurn = false;

  ctx.on("session/event", (_session: Session, event: SessionEvent) => {
    let u: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } | undefined = undefined;

    if (event.type === "assistant/chunk") {
      const chunk = (event.data as { chunk?: { type?: string; usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } } }).chunk;
      if (chunk?.type === "usage" && chunk.usage) {
        u = chunk.usage;
      }
    } else if (event.type === "assistant/message") {
      const msgUsage = (event.data as { usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } }).usage;
      if (msgUsage && !recordedInTurn) {
        u = msgUsage;
      }
      recordedInTurn = false; // Reset for next step/turn
    }

    if (!u) return;

    recordedInTurn = true;
    prompt = Math.max(prompt, u.inputTokens ?? 0);
    completion += u.outputTokens ?? 0;
    reasoning += u.reasoningTokens ?? 0;

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
 * Mirrors the built-in runSession() wiring in electron/ipc/session-runtime-handlers.ts, but
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
    if (kind === "done") emit("session:done", {});
    else emit("session:error", { error: error ?? "Agent error" });
  };
  if (signal?.aborted) finish("done");

  ctx.on("session/event", (session: Session, event: SessionEvent) => {
    // Only the parent session (this loop's dsh attempt id) — children are bridged
    // by cairnSubagentPlugin.
    if (String((session as { id?: unknown }).id) !== matchSessionId) return;
    const seq = event.seq;

    // ── Plan-mode flips (dsh-owned) ─────────────────────────────────────────
    // /plan (or planMode.set) commits a log-only plan/mode event; forward it so
    // the renderer's toggle reflects the authoritative session state.
    if (event.type === "plan/mode") {
      const active = (event.data as { active?: boolean } | undefined)?.active === true;
      emit("session:mode-change", { sessionId, mode: active ? "plan" : "execute" });
      return;
    }

    // ── Step boundary ────────────────────────────────────────────────────────
    // dsh opens a durable turn per step. The builtin fires onStepStart for every
    // step after the first so the renderer finalises the previous assistant
    // message. Map the first turn/start as tools/stream start and later ones as
    // step boundaries.
    if (event.type === "turn/start") {
      if (!firstTurnStarted) firstTurnStarted = true;
      else emit("session:step", {});
      return;
    }

    // ── Token / reasoning deltas ─────────────────────────────────────────────
    if (event.type === "assistant/chunk") {
      const c = (event.data as { chunk?: { type?: string; text?: string; usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } } }).chunk;
      if (!c) return;
      if (c.type === "text-delta" && c.text) {
        streamedText.add(sessionId);
        emit("session:token", { delta: c.text });
        return;
      }
      if (c.type === "reasoning-delta" && c.text) {
        streamedReasoning.add(sessionId);
        emit("session:thought", { delta: c.text });
        return;
      }
      if (c.type === "usage" && c.usage) {
        emit("session:usage", {
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
        emit("session:tools-ready", {});
      }
      const d = event.data as { name: string; arguments?: string; callId?: string };
      if (d.callId) callName.set(d.callId, d.name);
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(d.arguments ?? "{}") as Record<string, unknown>; } catch { /* keep {} */ }
      const callId = d.callId ?? `${d.name}:${seq}`;
      const label = d.name;
      callLabel.set(callId, label);

      // Plan-mode approval capture (dsh-native flow): when the model calls
      // exit_plan_mode, the FULL markdown plan is in args.plan. Persist it
      // eagerly on tool/call — before the user has actually approved — so
      // that if the user reloads mid-review or the app crashes, we can
      // re-present the same plan without losing it. If the user chooses
      // "Keep planning", the model will call exit_plan_mode again with a
      // revised plan, which overwrites this value. If the user Approves,
      // plan/mode flips off and execute-mode's next turn reads this cached
      // plan_content to keep the plan in its system prompt.
      if (d.name === "exit_plan_mode" && typeof args.plan === "string" && args.plan.trim().length > 0) {
        const db = getDb(ctx);
        if (db) {
          try {
            updateCodingSession(db, sessionId, { planContent: args.plan });
            emit("session:plan-note", { noteId: undefined, planContent: args.plan });
          } catch (err) {
            console.warn("[cordis] failed to persist plan_content:", err);
          }
        }
      }

      // "pending" chip (same as builtin onToolPending) — frontend treats it as a
      // running chip immediately, matching the streaming pending-state UX.
      emit("session:tool", { name: d.name, label, args, callId, status: "pending" });
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
      emit("session:tool", {
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
            if (row) emit("session:note-updated", { noteId: parsed.id, content: row.content ?? "" });
          }
        } catch { /* non-JSON output — ignore */ }
      }

      // ── plan-note: in plan mode, notify the renderer when the agent writes the PRD note.
      if (mode === "plan" && ok && name === "ensure_note") {
        try {
          const parsed = JSON.parse(output) as { id?: string };
          if (parsed?.id) emit("session:plan-note", { noteId: parsed.id });
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
          emit("session:todos", { todos: getSessionTodos(db, sessionId) });
        } catch { /* non-critical */ }
      }
      return;
    }

    // ── Final assistant message: fill text/reasoning gaps only ───────────────
    if (event.type === "assistant/message") {
      if (!streamedText.has(sessionId)) {
        const text = eventText(event);
        if (text) emit("session:token", { delta: text });
      }
      if (!streamedReasoning.has(sessionId)) {
        const { reasoning } = eventReasoning(event);
        if (reasoning) emit("session:thought", { delta: reasoning });
      }
      return;
    }

    // ── Retry: dsh-llm-retry records a durable llm/retry before each wait ─────
    if (event.type === "llm/retry") {
      const d = event.data as { retry?: number; maxRetries?: number; delayMs?: number; failure?: { message?: string; code?: string } };
      emit("session:retry", {
        attempt: (d.retry ?? 0) + 1,
        maxRetries: d.maxRetries ?? 0,
        delayMs: d.delayMs ?? 0,
        error: d.failure?.message ?? d.failure?.code ?? "Model request failed",
      });
      return;
    }

    // ── Compaction: BasicCompactionEngine auto-compacts at 80% context ────────
    if (event.type === "compaction/start") {
      emit("session:compact", { status: "start" });
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
      emit("session:compact", { status: "end", auto: true });
      if (!failed) {
        emit("session:compact-result", { messageCount: lastCompactCount, summary: lastCompactSummary });
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
        if (reason === "error") console.error("[cordis] turn/end error reason:", JSON.stringify((event.data as { reason?: unknown }).reason));
        finish("error", reason ? `Agent turn ended abnormally (${reason})` : "Agent turn ended abnormally");
      }
      return;
    }
  });
}

// ── cairn-approval ────────────────────────────────────────────────────────────
// Human-in-the-loop tool approval for the coding agent (Phase 1.5 step 2e).
// When autoApprove is OFF, mutating tools must be confirmed by the user before
// they run. dsh's approval seam (ctx.approval) + tools pipeline provide the
// mechanism: a `tools/pre-execute` handler returns {kind:'ask'} for a mutating
// tool, the pipeline calls ctx.approval.request, and this plugin's answerer
// bridges that to Cairn's renderer confirm UI (pi-agent:tool-confirm-required ⇄
// pi-agent:respond-tool). Read-only tools always pass (never ask).

/** Tools that never need approval (read-only / safe) — canonical list lives in
 *  shared/agent/tool-risk.ts, the same source the renderer's approval card uses
 *  so classification and UI can never drift again. */
const APPROVAL_SAFE = APPROVAL_SAFE_TOOLS;

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
  /** Fail-closed idle timeout for one ask. Defaults to APPROVAL_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Fail-closed idle timeout for interactive HITL prompts. Without it an ask
 * whose card was lost to a renderer reload blocks the loop forever (audit G6);
 * the automation inbox had the same 10-minute fail-closed budget before the
 * Cordis cutover.
 */
export const APPROVAL_TIMEOUT_MS = 10 * 60_000;

/**
 * Bridge dsh's approval seam to Cairn's renderer confirm UI. Mounted per turn.
 * No-op when autoApprove is true. Otherwise:
 *   1. tools/pre-execute → {kind:'ask'} for any non-safe tool (mutating) whose
 *      tool name / exact bash command hasn't been granted for the session.
 *   2. approval/request answerer → emit pi-agent:tool-confirm-required, block on
 *      pi-agent:respond-tool, map to allowed-once / rejected.
 * Grants (grant:'session' for a tool, grant:'command' for an exact bash
 * command) live in the per-session approval-grants store so they survive this
 * turn — this mount is disposed with it.
 */
export function cairnApprovalPlugin(ctx: Context, config: CairnApprovalConfig): (() => void) | void {
  const { autoApprove, sessionId, send, registerPending, signal, timeoutMs } = config;
  if (autoApprove) return;

  const disposers: Array<() => void> = [];
  // Durable per-session grants (survive this turn; cleared with the session).
  const grants = getSessionGrants(sessionId);
  const isGranted = (name: string, argsObj: Record<string, unknown>): boolean => {
    if (grants.tools.has(name)) return true;
    if (name === "bash") {
      const cmd = canonicalBashCommand(argsObj.command);
      if (cmd && grants.bashCommands.has(cmd)) return true;
    }
    return false;
  };

  // 1) Ask-trigger: mutating tools route to the approval seam.
  // ctx.on('tools/pre-execute', ...) — the waterfall event dsh-tools drives.
  // The generic arg is untyped in the augmentation for third-party events;
  // cast the handler's args narrowly to keep the touch site typed.
  const unsubPre = (ctx.on as unknown as (ev: string, fn: (...args: unknown[]) => unknown) => () => void)(
    "tools/pre-execute",
    (...args: unknown[]) => {
      const exec = args[0] as { name?: string; arguments?: unknown; callId?: string } | undefined;
      const next = args[1] as (() => Promise<unknown>) | undefined;
      const name = exec?.name;
      const argsObj = (exec?.arguments && typeof exec.arguments === "object") ? exec.arguments as Record<string, unknown> : {};
      if (typeof name === "string" && !APPROVAL_SAFE.has(name) && !isGranted(name, argsObj)) {
        // Stash the TRUSTED args so pi-agent:respond-tool can record a
        // grant:'command' against what dsh will actually execute — not
        // whatever string a compromised renderer echoes back. dsh's
        // ApprovalRequest deliberately carries no arguments (upstream
        // decision), so this main-side side-channel is the only way to keep
        // the grant target bound to the executed call.
        if (exec?.callId) recordPendingApprovalArgs(sessionId, exec.callId, argsObj);
        return Promise.resolve({ kind: "ask", reason: `"${name}" needs your approval before it runs.` });
      }
      return next ? next() : undefined;
    },
  );
  disposers.push(unsubPre);

  // 2) Answerer: bridge the ask to the renderer confirm UI.
  const unsubAns = (ctx.on as unknown as (ev: string, fn: (...args: unknown[]) => unknown) => () => void)(
    "approval/request",
    (...args: unknown[]) => {
      const req = args[0] as { toolName?: string; callId?: string; reason?: string; signal?: AbortSignal } | undefined;
      const toolName = req?.toolName ?? "tool";
      const callId = req?.callId ?? `approve-${newId()}`;
      if (grants.tools.has(toolName)) return Promise.resolve("allowed-once");
      send("session:tool-confirm-required", { sessionId, name: toolName, label: toolName, callId });
      return new Promise<string>((resolve) => {
        // Single-settle guard: exactly one of respond / abort / timeout wins,
        // and the abort listeners never linger after a normal settle.
        //
        // Synchronous-resolve safety: some transports (heartbeat-runner
        // auto-allow at :605-611, or a future optimistic-allow) call the
        // provided `resolve()` inside their `registerPending(callId, cb)`
        // call — before registerPending has returned its dispose function.
        // Two symptoms of naive code here:
        //   (a) `const dispose = registerPending(...)`: the callback runs
        //       during the initializer, hits `settle()` → `dispose()` and
        //       throws `ReferenceError: Cannot access 'dispose' before
        //       initialization` (TDZ). dsh catches → unavailable → deny.
        //   (b) A ref indirection alone (`disposeRef.current = registerPending`)
        //       has `disposeRef.current` still null when the synchronous
        //       callback runs, so dispose is never invoked and any registry
        //       entry leaks.
        // Fix: also buffer the outcome in `syncOutcome`. If the callback runs
        // synchronously, settle() early-returns and stashes it; after
        // registerPending returns we assign disposeRef.current and, if a sync
        // outcome was captured, replay settle() to run dispose + resolve.
        let settled = false;
        // eslint-disable-next-line prefer-const -- reassigned at end of block; declaration must precede settle() to avoid TDZ during sync replay.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAborts: Array<() => void> = [];
        const disposeRef: { current: (() => void) | null } = { current: null };
        let syncOutcome: "allowed-once" | "rejected" | "cancelled" | null = null;
        const settle = (outcome: "allowed-once" | "rejected" | "cancelled") => {
          if (settled) return;
          // Synchronous callback path: disposeRef.current isn't set yet.
          // Buffer the outcome; the initializer-tail replay below will run
          // this again with disposeRef.current populated.
          if (disposeRef.current === null && syncOutcome === null) {
            syncOutcome = outcome;
            return;
          }
          settled = true;
          clearTimeout(timer);
          disposeRef.current?.();
          for (const off of onAborts) off();
          // Drop the trusted args stash for this callId — the ask settled.
          forgetPendingApprovalArgs(sessionId, callId);
          resolve(outcome);
        };
        disposeRef.current = registerPending(callId, (decision) => {
          if (decision.approved && decision.grant === "session") grants.tools.add(toolName);
          // grant:"command" is recorded by the pi-agent:respond-tool handler,
          // which owns the canonicalized command text (dsh's ApprovalRequest
          // deliberately carries no args).
          settle(decision.approved ? "allowed-once" : "rejected");
        });
        // Replay a buffered sync outcome now that disposeRef is populated.
        if (syncOutcome !== null && !settled) {
          const captured = syncOutcome;
          syncOutcome = null;
          settle(captured);
        }
        const onAbort = () => settle("cancelled");
        if (req?.signal?.aborted || signal?.aborted) onAbort();
        for (const sig of [req?.signal, signal]) {
          if (!sig) continue;
          sig.addEventListener?.("abort", onAbort, { once: true });
          onAborts.push(() => sig.removeEventListener?.("abort", onAbort));
        }
        timer = setTimeout(() => {
          if (settled) return;
          send("session:tool-confirm-expired", { sessionId, name: toolName, label: toolName, callId });
          settle("cancelled");
        }, timeoutMs ?? APPROVAL_TIMEOUT_MS);
      });
    },
  );
  disposers.push(unsubAns);

  return () => { for (const d of disposers) { try { d(); } catch { /* noop */ } } };
}
