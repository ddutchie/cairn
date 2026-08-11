/**
 * Local-only chat persistence (on-device, never synced).
 *
 * Chat history is intentionally kept out of the sync engine: it lives in the
 * `chat_local` table which has NO capture trigger, so nothing is published to
 * or pulled from the iCloud sync folder. This lets the conversation survive app
 * relaunches while remaining private to the device.
 */

import { getMeta, setMeta, getDb } from "./index";

import type { ChatUsage } from "@/chat/providers/types";

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  images?: string[]; // data URIs — shown live in-session, NOT persisted (see below)
  tools?: ToolCall[];
}

/** A tool the agent ran, plus an optional navigable note/card it produced. */
export interface ToolCall {
  tool: string;
  args?: Record<string, unknown>;
  ok: boolean;
  /** Correlates the streaming "running" chip with its completed result. */
  id?: string;
  /** True while the tool is executing (before its result arrives). Not persisted. */
  running?: boolean;
  /** Set when the tool created/returned a note or card, so the chip can open it. */
  ref?: { kind: "note" | "card"; id: string };
  /**
   * Set when a web/MCP/service tool result carries a linkable external artefact
   * (a web-search hit, a docs page, …), so the chip can open it in the browser.
   * https-guarded at extraction (shared/chat/external-ref).
   */
  externalRef?: { url: string; title?: string; snippet?: string };
  output?: string;
}

interface ChatLocalRow {
  role: string;
  content: string;
  images: string | null;
  tools: string | null;
  created_at: string;
}

/** Max messages to keep / load. Chat is a rolling window, not an archive. */
const HISTORY_LIMIT = 200;
/** Prune once the table grows past this (a bit above the load window). */
const PRUNE_THRESHOLD = 400;

function parseJsonArray<T>(json: string | null): T[] | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) && v.length > 0 ? (v as T[]) : undefined;
  } catch {
    return undefined;
  }
}

/** Load recent local chat history (most recent HISTORY_LIMIT), chronological. */
export function loadChatHistory(): StoredMessage[] {
  // Take the newest N by seq, then reverse to chronological order — bounded so a
  // long-lived conversation doesn't read the whole table (and huge blobs) on
  // every launch.
  const rows = getDb().getAllSync<ChatLocalRow>(
    `SELECT role, content, images, tools, created_at FROM (
       SELECT * FROM chat_local ORDER BY seq DESC LIMIT ?
     ) ORDER BY seq ASC`,
    HISTORY_LIMIT,
  );
  return rows.map((r) => {
    const m: StoredMessage = { role: r.role === "user" ? "user" : "assistant", content: r.content };
    const images = parseJsonArray<string>(r.images);
    if (images) m.images = images;
    const tools = parseJsonArray<ToolCall>(r.tools);
    if (tools) m.tools = tools;
    return m;
  });
}

/**
 * Append one completed message to the local history.
 *
 * Image data URIs are deliberately NOT persisted: they're large base64 blobs
 * that would bloat the on-device DB and slow every launch. They still render
 * live during the session (the UI holds them in component state); only the
 * durable text/tool trail is stored. Old rows are pruned to keep the table
 * bounded.
 */
export function saveChatMessage(m: StoredMessage): void {
  const db = getDb();
  db.runSync(
    `INSERT INTO chat_local (role, content, images, tools, created_at) VALUES (?, ?, ?, ?, ?)`,
    m.role,
    m.content,
    null, // images not persisted (see doc above)
    m.tools && m.tools.length ? JSON.stringify(m.tools) : null,
    new Date().toISOString(),
  );
  // Cheap periodic prune: trim to the most recent HISTORY_LIMIT once we exceed
  // the threshold, so growth is bounded without pruning on every insert.
  const countRow = db.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM chat_local`);
  if ((countRow?.n ?? 0) > PRUNE_THRESHOLD) {
    db.runSync(
      `DELETE FROM chat_local WHERE seq <= (
         SELECT seq FROM chat_local ORDER BY seq DESC LIMIT 1 OFFSET ?
       )`,
      HISTORY_LIMIT,
    );
  }
}

/** Whether any chat history exists (to gate the "Clear" affordance). */
export function hasChatHistory(): boolean {
  const row = getDb().getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM chat_local`);
  return (row?.n ?? 0) > 0;
}

/** Delete all local chat history. */
export function clearChatHistory(): void {
  getDb().runSync(`DELETE FROM chat_local`);
  clearLastChatUsage();
}

// ── Last context-window usage ────────────────────────────────────────────────
// The context ring is per-conversation session state; persist the latest value
// so reopening the Chat tab restores the ring instead of showing nothing until
// the next turn.
//
// Stored in the DEVICE-GLOBAL meta DB (like AI config), NOT the per-workspace
// source DB's `app_settings` — that table is deleted on the legacy→multi-source
// upgrade and differs per workspace, so the ring used to reset to empty after an
// upgrade or a workspace switch. Meta survives both. A one-time lazy migration
// picks up a value previously written to `app_settings`.

const USAGE_KEY = "chat.lastUsage";

/** Parse a persisted JSON blob into a ChatUsage, or null when invalid. */
function parseUsage(raw: string | null | undefined): ChatUsage | null {
  if (!raw) return null;
  try {
    const u = JSON.parse(raw) as Partial<ChatUsage>;
    if (typeof u.promptTokens === "number" && typeof u.contextLimit === "number" && u.contextLimit > 0) {
      return {
        promptTokens: u.promptTokens,
        contextLimit: u.contextLimit,
        estimated: u.estimated,
        breakdown: u.breakdown,
        completionTokens: u.completionTokens,
        reasoningTokens: u.reasoningTokens,
        costUsd: typeof u.costUsd === "number" ? u.costUsd : undefined,
        cacheReadTokens: typeof u.cacheReadTokens === "number" ? u.cacheReadTokens : undefined,
        cacheCreationTokens: typeof u.cacheCreationTokens === "number" ? u.cacheCreationTokens : undefined,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Persist the most recent context-window usage for the ring. */
export function saveLastChatUsage(usage: ChatUsage): void {
  setMeta(USAGE_KEY, JSON.stringify(usage));
}

/** Load the last persisted context-window usage, or null. */
export function loadLastChatUsage(): ChatUsage | null {
  // Device-global meta is the source of truth (survives workspace switches and
  // the upgrade that wipes per-workspace app_settings).
  const fromMeta = parseUsage(getMeta(USAGE_KEY));
  if (fromMeta) return fromMeta;
  // One-time lazy migration from the old per-workspace app_settings location.
  // Guarded: a fresh/migrated DB may not even have the app_settings table yet,
  // in which case there's nothing to migrate.
  try {
    const legacy = getDb().getFirstSync<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", USAGE_KEY);
    if (legacy?.value) {
      const migrated = parseUsage(legacy.value);
      if (migrated) {
        setMeta(USAGE_KEY, legacy.value);
        return migrated;
      }
    }
  } catch {
    /* app_settings unavailable (pre-migration DB) — no legacy value to migrate */
  }
  return null;
}

/** Clear the persisted usage (on chat clear). */
export function clearLastChatUsage(): void {
  setMeta(USAGE_KEY, "");
  // Best-effort cleanup of the legacy location.
  try {
    getDb().runSync("DELETE FROM app_settings WHERE key = ?", USAGE_KEY);
  } catch {
    /* ignore */
  }
}

// ── Chat usage HISTORY (Usage screen) ────────────────────────────────────────

export interface ChatUsageRow {
  seq: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  estimated: boolean;
  provider: string;
  model: string;
  createdAt: string;
}

/** Append one usage record for a chat turn (local-only; never synced). */
export function recordChatUsage(usage: ChatUsage, provider: string, model: string): void {
  const now = new Date().toISOString();
  getDb().runSync(
    `INSERT INTO chat_usage
       (prompt_tokens, completion_tokens, reasoning_tokens, cache_read_tokens,
        cache_creation_tokens, cost_usd, estimated, provider, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    Math.max(0, Math.round(usage.promptTokens)),
    Math.max(0, Math.round(usage.completionTokens ?? 0)),
    Math.max(0, Math.round(usage.reasoningTokens ?? 0)),
    Math.max(0, Math.round(usage.cacheReadTokens ?? 0)),
    Math.max(0, Math.round(usage.cacheCreationTokens ?? 0)),
    typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) ? usage.costUsd : null,
    usage.estimated === true ? 1 : 0,
    provider,
    model,
    now,
  );
}

/** Most-recent-first chat usage history. */
export function loadChatUsageHistory(limit = 200): ChatUsageRow[] {
  return getDb()
    .getAllSync<{
      seq: number;
      prompt_tokens: number;
      completion_tokens: number;
      reasoning_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      cost_usd: number | null;
      estimated: number;
      provider: string;
      model: string;
      created_at: string;
    }>(
      `SELECT seq, prompt_tokens, completion_tokens, reasoning_tokens, cache_read_tokens,
              cache_creation_tokens, cost_usd, estimated, provider, model, created_at
       FROM chat_usage ORDER BY seq DESC LIMIT ?`,
      limit,
    )
    .map((r) => ({
      seq: r.seq,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      reasoningTokens: r.reasoning_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheCreationTokens: r.cache_creation_tokens,
      costUsd: r.cost_usd,
      estimated: r.estimated === 1,
      provider: r.provider,
      model: r.model,
      createdAt: r.created_at,
    }));
}

/** Wipe the chat usage history (fresh start / privacy). */
export function clearChatUsageHistory(): void {
  getDb().runSync("DELETE FROM chat_usage");
}
