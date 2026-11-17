import { describe, it, expect, beforeEach, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { applySchema } from "../db/schema";
import { notifyAgentAttention, _resetAgentAttention } from "./agent-attention";
import { _resetSessionsOnScreen, forgetWindowSessions, isSessionOnScreen, markSessionOnScreen } from "./session-on-screen";

describe("notifyAgentAttention", () => {
  let db: Database.Database;
  const rows = () => db.prepare("SELECT tool, title, body, target_type, target_id FROM mcp_notifications ORDER BY created_at").all() as Array<Record<string, string>>;

  beforeEach(() => {
    db = new BetterSqlite3(":memory:");
    applySchema(db);
    _resetAgentAttention();
  });

  it("does nothing while a window is focused", () => {
    expect(notifyAgentAttention(db, { sessionId: "s1", kind: "finished" }, () => true)).toBe(false);
    expect(rows()).toEqual([]);
  });

  it("records a session-targeted notification when unfocused", () => {
    expect(notifyAgentAttention(db, { sessionId: "s1", kind: "approval", detail: "Run  bash\n npm test" }, () => false)).toBe(true);
    expect(rows()).toEqual([
      { tool: "agent_approval", title: "Agent needs approval", body: "Coding session — Run bash npm test", target_type: "session", target_id: "s1" },
    ]);
  });

  it("debounces repeats of the same kind per session", () => {
    const off = () => false;
    notifyAgentAttention(db, { sessionId: "s1", kind: "approval" }, off, 1_000);
    notifyAgentAttention(db, { sessionId: "s1", kind: "approval" }, off, 5_000);
    notifyAgentAttention(db, { sessionId: "s1", kind: "finished" }, off, 6_000);
    notifyAgentAttention(db, { sessionId: "s1", kind: "approval" }, off, 40_000);
    expect(rows().map((r) => r.tool)).toEqual(["agent_approval", "agent_finished", "agent_approval"]);
  });

  it("records an approval while focused when no window shows the session", () => {
    const focused = () => true;
    expect(notifyAgentAttention(db, { sessionId: "s1", kind: "approval" }, focused, 1_000, () => true)).toBe(false);
    expect(notifyAgentAttention(db, { sessionId: "s1", kind: "approval" }, focused, 2_000, () => false)).toBe(true);
    // A finished turn still waits for Cairn to be in the background.
    expect(notifyAgentAttention(db, { sessionId: "s1", kind: "finished" }, focused, 3_000, () => false)).toBe(false);
    expect(rows().map((r) => r.tool)).toEqual(["agent_approval"]);
  });

  it("names a chat session by its thread title", () => {
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO chat_threads (id, workspace_id, title, created_at, updated_at) VALUES ('t1', 'w1', 'Plan the launch', 0, 0)").run();
    notifyAgentAttention(db, { sessionId: "chat-t1", kind: "approval", detail: "Post to Slack" }, () => false);
    notifyAgentAttention(db, { sessionId: "chat-t2", kind: "approval" }, () => false);
    expect(rows().map((r) => r.body)).toEqual(["Plan the launch — Post to Slack", "Chat"]);
  });
});

describe("sessions on screen", () => {
  beforeEach(() => _resetSessionsOnScreen());

  it("counts each window's reports and forgets a window at once", () => {
    markSessionOnScreen(1, "s1", true);
    markSessionOnScreen(1, "s1", true);
    markSessionOnScreen(1, "s1", false);
    expect(isSessionOnScreen("s1")).toBe(true);
    markSessionOnScreen(1, "s1", false);
    expect(isSessionOnScreen("s1")).toBe(false);
    markSessionOnScreen(2, "s2", true);
    forgetWindowSessions(2);
    expect(isSessionOnScreen("s2")).toBe(false);
  });
});
