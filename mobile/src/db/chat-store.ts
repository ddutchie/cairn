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
  images?: string[]; // data URIs
  tools?: { tool: string; ok: boolean }[];
}

interface ChatLocalRow {
  role: string;
  content: string;
  images: string | null;
  tools: string | null;
  created_at: string;
}

function parseJsonArray<T>(json: string | null): T[] | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) && v.length > 0 ? (v as T[]) : undefined;
  } catch {
    return undefined;
  }
}

/** Load the full local chat history in chronological order. */
export function loadChatHistory(): StoredMessage[] {
  const rows = getDb().getAllSync<ChatLocalRow>(
    `SELECT role, content, images, tools, created_at FROM chat_local ORDER BY seq ASC`,
  );
  return rows.map((r) => {
    const m: StoredMessage = { role: r.role === "user" ? "user" : "assistant", content: r.content };
    const images = parseJsonArray<string>(r.images);
    if (images) m.images = images;
    const tools = parseJsonArray<{ tool: string; ok: boolean }>(r.tools);
    if (tools) m.tools = tools;
    return m;
  });
}

/** Append one completed message to the local history. */
export function saveChatMessage(m: StoredMessage): void {
  getDb().runSync(
    `INSERT INTO chat_local (role, content, images, tools, created_at) VALUES (?, ?, ?, ?, ?)`,
    m.role,
    m.content,
    m.images && m.images.length ? JSON.stringify(m.images) : null,
    m.tools && m.tools.length ? JSON.stringify(m.tools) : null,
    new Date().toISOString(),
  );
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
