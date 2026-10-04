/**
 * Agent attention — tell the user when a coding session needs them while
 * Cairn is in the background.
 *
 * Inserts an `mcp_notifications` row (target_type "session") when a turn
 * finishes or fails, or when the agent asks for an approval or an answer, but
 * only while no Cairn window is focused. The existing notification poller then
 * raises the native toast and the dock/tray badge, and the in-app bell lists it
 * with a click-through to the session. When a window is focused, the user is
 * already looking at Cairn, so nothing is recorded.
 */

import { BrowserWindow } from "electron";
import type Database from "better-sqlite3";
import { insertNotification } from "../mcp/db";
import { getCodingSessionById } from "../db/sessions-queries";

export type AttentionKind = "finished" | "failed" | "approval" | "question";

const TITLE: Record<AttentionKind, string> = {
  finished: "Agent finished",
  failed: "Agent stopped with an error",
  approval: "Agent needs approval",
  question: "Agent has a question",
};

/** Per-session, per-kind cooldown so a burst of approvals is one toast. */
const COOLDOWN_MS = 30_000;
const lastSent = new Map<string, number>();

function anyWindowFocused(): boolean {
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible() && w.isFocused());
}

export interface AttentionEvent {
  sessionId: string;
  kind: AttentionKind;
  /** Extra context, e.g. the tool awaiting approval or the error message. */
  detail?: string;
}

/**
 * Record an attention notification for `sessionId` if the app is unfocused.
 * `isFocused` is injectable for tests. Returns true when a row was written.
 */
export function notifyAgentAttention(
  db: Database.Database,
  ev: AttentionEvent,
  isFocused: () => boolean = anyWindowFocused,
  now: number = Date.now(),
): boolean {
  if (isFocused()) return false;
  const key = `${ev.sessionId}:${ev.kind}`;
  const prev = lastSent.get(key);
  if (prev !== undefined && now - prev < COOLDOWN_MS) return false;
  lastSent.set(key, now);
  if (lastSent.size > 200) {
    for (const [k, t] of lastSent) if (now - t >= COOLDOWN_MS) lastSent.delete(k);
  }

  let name = "Coding session";
  try {
    const row = getCodingSessionById(db, ev.sessionId);
    if (row?.taskTitle) name = row.taskTitle;
  } catch { /* metadata is best-effort */ }

  const detail = ev.detail ? ev.detail.replace(/\s+/g, " ").trim().slice(0, 140) : "";
  insertNotification(db, `agent_${ev.kind}`, TITLE[ev.kind], detail ? `${name} — ${detail}` : name, {
    type: "session",
    id: ev.sessionId,
  });
  return true;
}

/** Test hook: forget cooldown state. */
export function _resetAgentAttention(): void {
  lastSent.clear();
}
