import { describe, it, expect, beforeEach, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { applySchema } from "../db/schema";
import { notifyAgentAttention, _resetAgentAttention } from "./agent-attention";

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
});
