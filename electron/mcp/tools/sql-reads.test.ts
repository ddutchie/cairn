/**
 * SQL-backed reads: full-text ranking, unchanged substring recall, the filters,
 * and the tasks_fts index staying in step with task_cards.
 */
import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../../db/schema";
import { createWorkspace, createProject, createColumn, createNote, createCard, createTag, updateCard, deleteNote } from "../../db/queries";
import { searchNotesSql, searchTasksSql, listOverdueTasksSql, listTasksDueSql } from "./sql-reads";

type Row = { id: string };
let db: Database.Database;
const ids = (r: unknown) => (r as Row[]).map((x) => x.id);

beforeEach(() => {
  db = new BetterSqlite3(":memory:");
  applySchema(db);
  createWorkspace(db, { id: "ws", name: "WS" });
  createProject(db, { id: "p", workspaceId: "ws", name: "P" });
  createProject(db, { id: "p2", workspaceId: "ws", name: "P2" });
  createColumn(db, { id: "todo", projectId: "p", workspaceId: "ws", name: "Todo", type: "todo", order: 0 });
  createColumn(db, { id: "done", projectId: "p", workspaceId: "ws", name: "Done", type: "done", order: 1 });
  createTag(db, { id: "t", workspaceId: "ws", name: "Urgent", color: "#f00" });
});

describe("searchNotesSql", () => {
  it("ranks a title match above a passing body mention", () => {
    createNote(db, { id: "body", projectId: "p", workspaceId: "ws", title: "Weekly log", content: "touched the auth module briefly" });
    createNote(db, { id: "title", projectId: "p", workspaceId: "ws", title: "Auth design", content: "tokens" });
    expect(ids(searchNotesSql(db, { query: "auth" }))[0]).toBe("title");
  });

  it("keeps substring matches token search can't see, and ignores tokenizer-dropped punctuation", () => {
    createNote(db, { id: "oauth", projectId: "p", workspaceId: "ws", title: "OAuth flow", content: "" });
    createNote(db, { id: "cpp", projectId: "p", workspaceId: "ws", title: "Notes", content: "written in c++" });
    createNote(db, { id: "c", projectId: "p", workspaceId: "ws", title: "Cats", content: "cute" });
    expect(ids(searchNotesSql(db, { query: "auth" }))).toContain("oauth");
    expect(ids(searchNotesSql(db, { query: "c++" }))).toEqual(["cpp"]);
  });

  it("filters by project, folder, tag and type, and skips deleted notes", () => {
    createNote(db, { id: "a", projectId: "p", workspaceId: "ws", title: "Plan", content: "x", folder: "Specs", tagIds: ["t"] });
    createNote(db, { id: "b", projectId: "p2", workspaceId: "ws", title: "Plan", content: "x" });
    createNote(db, { id: "tpl", projectId: "p", workspaceId: "ws", title: "Plan tpl", content: "x", type: "template" });
    createNote(db, { id: "gone", projectId: "p", workspaceId: "ws", title: "Plan", content: "x" });
    deleteNote(db, "gone");
    expect(ids(searchNotesSql(db, { query: "plan", projectId: "p2" }))).toEqual(["b"]);
    expect(ids(searchNotesSql(db, { query: "", folder: "specs" }))).toEqual(["a"]);
    expect(ids(searchNotesSql(db, { query: "", tag: "urgent" }))).toEqual(["a"]);
    expect(ids(searchNotesSql(db, { query: "", type: "template" }))).toEqual(["tpl"]);
    expect(ids(searchNotesSql(db, { query: "plan", limit: 50 }))).not.toContain("gone");
  });

  it("returns the documented shape with a plain-text snippet", () => {
    createNote(db, { id: "n", projectId: "p", workspaceId: "ws", title: "Spec", content: "# Heading\n\n**Bold** text" });
    expect(searchNotesSql(db, { query: "spec" })).toEqual([
      { id: "n", title: "Spec", snippet: expect.not.stringContaining("**"), projectId: "p", folder: "", updatedAt: expect.any(String) },
    ]);
  });
});

describe("searchTasksSql + tasks_fts", () => {
  it("indexes new and edited cards and ranks title matches first", () => {
    createCard(db, { id: "k1", columnId: "todo", projectId: "p", workspaceId: "ws", title: "Write docs", description: "mention login once" });
    createCard(db, { id: "k2", columnId: "todo", projectId: "p", workspaceId: "ws", title: "Login bug" });
    expect(ids(searchTasksSql(db, { query: "login" }))).toEqual(["k2", "k1"]);
    updateCard(db, "k1", { title: "Write docs", description: "nothing here" });
    expect(ids(searchTasksSql(db, { query: "login" }))).toEqual(["k2"]);
  });

  it("filters by column type, assignee and tag", () => {
    createCard(db, { id: "k1", columnId: "todo", projectId: "p", workspaceId: "ws", title: "A", assignee: "Alex", tagIds: ["t"] });
    createCard(db, { id: "k2", columnId: "done", projectId: "p", workspaceId: "ws", title: "B" });
    expect(ids(searchTasksSql(db, { query: "", columnType: "done" }))).toEqual(["k2"]);
    expect(ids(searchTasksSql(db, { query: "", assignee: "alex" }))).toEqual(["k1"]);
    expect(ids(searchTasksSql(db, { query: "", tag: "Urgent" }))).toEqual(["k1"]);
  });

  it("falls back to substring search on a workspace without tasks_fts (unmigrated, MCP-only)", () => {
    createCard(db, { id: "k", columnId: "todo", projectId: "p", workspaceId: "ws", title: "Fix login" });
    db.exec("DROP TABLE tasks_fts");
    expect(ids(searchTasksSql(db, { query: "login" }))).toEqual(["k"]);
  });

  it("migration back-fills cards that existed before the index", () => {
    createCard(db, { id: "old", columnId: "todo", projectId: "p", workspaceId: "ws", title: "Legacy refactor" });
    db.exec("DELETE FROM tasks_fts");
    db.prepare("INSERT INTO tasks_fts(tasks_fts) VALUES ('rebuild')").run();
    expect(ids(searchTasksSql(db, { query: "refactor" }))).toEqual(["old"]);
  });
});

describe("due lists", () => {
  it("lists open dated cards, skipping done columns", () => {
    createCard(db, { id: "late", columnId: "todo", projectId: "p", workspaceId: "ws", title: "Late", dueDate: "2000-01-01" });
    createCard(db, { id: "doneLate", columnId: "done", projectId: "p", workspaceId: "ws", title: "Done", dueDate: "2000-01-01" });
    expect(ids(listOverdueTasksSql(db, {}))).toEqual(["late"]);
    expect(ids(listTasksDueSql(db, { days: 7 }))).toEqual(["late"]);
    expect(ids(listTasksDueSql(db, { days: 7, includeOverdue: false }))).toEqual([]);
  });
});
