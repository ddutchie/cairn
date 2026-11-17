/**
 * Agent attention — tell the user when a session needs them and they can't see it.
 *
 * Inserts an `mcp_notifications` row (target_type "session") when a turn
 * finishes or fails, or when the agent asks for an approval or an answer. A
 * finished or failed turn is only recorded while no Cairn window is focused.
 * An approval or a question is also recorded while Cairn is focused, when no
 * window is showing that session (a chat in the background, a closed panel):
 * the run is blocked until the user answers. The existing notification poller
 * raises the native toast and the dock/tray badge while Cairn is in the
 * background, and the in-app bell lists it with a click-through to the session.
 */

import { BrowserWindow } from "electron";
import type Database from "better-sqlite3";
import { insertNotification } from "../mcp/db";
import { getCodingSessionById } from "../db/sessions-queries";
import { getChatThreadTitle } from "../db/chat-queries";
import { isSessionOnScreen } from "./session-on-screen";

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

/** Kinds that block the run until the user answers. */
const BLOCKING: ReadonlySet<AttentionKind> = new Set(["approval", "question"]);

/**
 * Record an attention notification for `sessionId` if the user can't see it:
 * the app is unfocused, or (for an approval or question) no window shows the
 * session. `isFocused` and `onScreen` are injectable for tests. Returns true
 * when a row was written.
 */
export function notifyAgentAttention(
  db: Database.Database,
  ev: AttentionEvent,
  isFocused: () => boolean = anyWindowFocused,
  now: number = Date.now(),
  onScreen: (sessionId: string) => boolean = isSessionOnScreen,
): boolean {
  if (isFocused() && (!BLOCKING.has(ev.kind) || onScreen(ev.sessionId))) return false;
  const key = `${ev.sessionId}:${ev.kind}`;
  const prev = lastSent.get(key);
  if (prev !== undefined && now - prev < COOLDOWN_MS) return false;
  lastSent.set(key, now);
  if (lastSent.size > 200) {
    for (const [k, t] of lastSent) if (now - t >= COOLDOWN_MS) lastSent.delete(k);
  }

  const chat = ev.sessionId.startsWith("chat-");
  let name = chat ? "Chat" : "Coding session";
  try {
    if (chat) {
      name = getChatThreadTitle(db, ev.sessionId.slice("chat-".length)) ?? name;
    } else {
      const row = getCodingSessionById(db, ev.sessionId);
      if (row?.taskTitle) name = row.taskTitle;
    }
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
