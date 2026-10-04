import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { applySchema } from "../../db/schema";
import { createWorkspace, createProject, createColumn, createCard, getCardById } from "../../db/queries";
import { executeTool } from "../../mcp-server";
import { appendProgressEntry } from "./tasks";

const NOW = new Date("2026-10-04T09:30:00.000Z");

describe("appendProgressEntry", () => {
  it("creates the section, then appends inside it before the next heading", () => {
    const one = appendProgressEntry("Do the thing.", "Claude", "claimed", NOW);
    expect(one).toBe("Do the thing.\n\n## Progress\n\n- 2026-10-04 09:30 · Claude: claimed");
    const withTail = `${one}\n\n## Notes\nkeep me`;
    const two = appendProgressEntry(withTail, "Claude", "halfway\nthere", NOW);
    expect(two).toBe("Do the thing.\n\n## Progress\n\n- 2026-10-04 09:30 · Claude: claimed\n- 2026-10-04 09:30 · Claude: halfway there\n\n## Notes\nkeep me");
  });
  it("handles an empty description", () => {
    expect(appendProgressEntry(undefined, "", "x", NOW)).toBe("## Progress\n\n- 2026-10-04 09:30 · agent: x");
  });
});

describe("claim_task / add_task_progress", () => {
  let db: Database.Database;
  let wp: string;
  const run = (name: string, args: Record<string, unknown>) => executeTool(db, wp, name, args) as Record<string, unknown>;

  beforeEach(() => {
    db = new BetterSqlite3(":memory:");
    applySchema(db);
    wp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-handoff-"));
    createWorkspace(db, { id: "ws", name: "W" });
    createProject(db, { id: "p", workspaceId: "ws", name: "P" });
    for (const [id, type, order] of [["todo", "todo", 0], ["ip", "in_progress", 1], ["rev", "review", 2], ["done", "done", 3]] as const) {
      createColumn(db, { id, projectId: "p", workspaceId: "ws", name: id.toUpperCase(), type, order });
    }
    createCard(db, { id: "c", columnId: "todo", projectId: "p", workspaceId: "ws", title: "Build it" });
    createCard(db, { id: "dep", columnId: "todo", projectId: "p", workspaceId: "ws", title: "After" });
    db.prepare(`UPDATE task_cards SET blocked_by_ids = '["c"]' WHERE id = 'dep'`).run();
  });
  afterEach(() => fs.rmSync(wp, { recursive: true, force: true }));

  it("claims: assigns, logs and moves to In Progress; refuses a second agent without force", () => {
    const res = run("claim_task", { cardId: "c", agent: "Claude Code" });
    expect(res.error).toBeUndefined();
    const card = getCardById(db, "c")!;
    expect(card.assignee).toBe("Claude Code");
    expect(card.columnId).toBe("ip");
    expect(card.description).toMatch(/## Progress\n\n- .* · Claude Code: claimed$/);

    expect(run("claim_task", { cardId: "c", agent: "Cursor" }).error).toMatch(/already claimed by "Claude Code"/);
    expect(run("claim_task", { cardId: "c", agent: "Cursor", force: true }).error).toBeUndefined();
    expect(getCardById(db, "c")!.description).toMatch(/Cursor: took over from Claude Code$/);
  });

  it("logs progress and finishing to done unblocks dependents and stamps completedAt", () => {
    run("claim_task", { cardId: "c", agent: "Claude Code" });
    run("add_task_progress", { cardId: "c", message: "tests written" });
    expect(getCardById(db, "c")!.description).toMatch(/Claude Code: tests written$/);

    const res = run("add_task_progress", { cardId: "c", message: "shipped", moveTo: "done" });
    expect(res.movedTo).toBe("DONE");
    const card = getCardById(db, "c")!;
    expect(card.columnId).toBe("done");
    expect(card.completedAt).toBeTruthy();
    expect(getCardById(db, "dep")!.blockedByIds).toEqual([]);
  });

  it("checks the claim against the live row, not a stale snapshot", () => {
    // Someone else claimed it directly in the DB after the snapshot was taken.
    db.prepare("UPDATE task_cards SET assignee = 'Cursor' WHERE id = 'c'").run();
    expect(run("claim_task", { cardId: "c", agent: "Claude Code" }).error).toMatch(/already claimed by "Cursor"/);
  });

  it("validates input", () => {
    expect(run("claim_task", { cardId: "c", agent: " " }).error).toMatch(/agent is required/);
    expect(run("add_task_progress", { cardId: "c", message: "" }).error).toMatch(/message is required/);
    expect(run("add_task_progress", { cardId: "nope", message: "x" }).error).toMatch(/not found/);
  });
});
