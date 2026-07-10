/**
 * Local-only chat persistence (on-device, never synced).
 *
 * Chat history is intentionally kept out of the sync engine: it lives in the
 * `chat_local` table which has NO capture trigger, so nothing is published to
 * or pulled from the iCloud sync folder. This lets the conversation survive app
 * relaunches while remaining private to the device.
 */

import { getDb } from "./index";

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  images?: string[]; // data URIs — shown live in-session, NOT persisted (see below)
  tools?: ToolCall[];
}

/** A tool the agent ran, plus an optional navigable note/card it produced. */
export interface ToolCall {
  tool: string;
  ok: boolean;
  /** Set when the tool created/returned a note or card, so the chip can open it. */
  ref?: { kind: "note" | "card"; id: string };
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
}
