import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import { createHostStore } from "./host-store";

function makeDb() {
  const db = new Database(":memory:");
  applySchema(db);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws', 'W', ?, ?)").run(now, now);
  return db;
}

describe("HostStore.indexChatThread", () => {
  it("creates the row once and keeps its title, scope and subagent flag on re-index", () => {
    const db = makeDb();
    const host = createHostStore(db);
    host.indexChatThread("t1", "ws");
    db.prepare("UPDATE chat_threads SET title = 'Kept', use_subagents = 1, scope = 'project' WHERE id = 't1'").run();
    host.indexChatThread("t1", "ws");
    const row = db.prepare("SELECT title, use_subagents, scope FROM chat_threads WHERE id = 't1'").get();
    expect(row).toEqual({ title: "Kept", use_subagents: 1, scope: "project" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM chat_threads").get() as { n: number }).n).toBe(1);
  });
});
