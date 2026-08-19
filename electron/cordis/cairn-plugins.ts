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
export function cairnDbPlugin(ctx: Context, config: CairnDbConfig): () => void {
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
