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
      if (c.type === "text-delta" && c.text) send("chat:subagent-token", { childId, delta: c.text });
      if (c.type === "reasoning-delta" && c.text) send("chat:subagent-thought", { childId, delta: c.text });
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
      const text = eventText(event);
      if (text) send("chat:subagent-token", { childId, delta: text });
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
