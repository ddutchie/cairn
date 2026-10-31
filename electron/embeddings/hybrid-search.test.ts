/**
 * searchAdjacent / searchAdjacentTasks with FTS5 fused in: an opaque id the
 * embedding can't see is found by keyword, archived cards stay out, and a note
 * with no embedding yet is still reachable.
 */
import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject, createColumn, createNote, createCard, updateCard } from "../db/queries";
import { upsertNoteEmbedding, upsertTaskEmbedding } from "../db/embeddings-queries";
import { searchAdjacent, searchAdjacentTasks, type EmbedFn } from "./service";

const MODEL = "test-model";
// Query always embeds to e0; documents are placed at an angle to it.
const embed: EmbedFn = async (texts) => texts.map(() => [1, 0, 0]);
const vec = (cos: number) => [cos, Math.sqrt(1 - cos * cos), 0];

let db: Database.Database;
beforeEach(() => {
  db = new BetterSqlite3(":memory:");
  applySchema(db);
  createWorkspace(db, { id: "ws", name: "WS" });
  createProject(db, { id: "p", workspaceId: "ws", name: "P" });
  createColumn(db, { id: "todo", projectId: "p", workspaceId: "ws", name: "Todo", type: "todo", order: 0 });
});

const embedNote = (id: string, cos: number, idx = 0) =>
  upsertNoteEmbedding(db, { noteId: id, sectionIdx: idx, sectionTitle: `S${idx}`, workspaceId: "ws", model: MODEL, task: "search_document", contentHash: id + idx, vector: vec(cos) });

describe("searchAdjacent (hybrid)", () => {
  it("surfaces the note holding an opaque id even when its embedding is a poor match", async () => {
    createNote(db, { id: "runbook", projectId: "p", workspaceId: "ws", title: "Payment runbook", content: "When the gateway returns ERR-4021 retry with backoff" });
    for (let i = 0; i < 8; i++) {
      createNote(db, { id: `other${i}`, projectId: "p", workspaceId: "ws", title: `Other ${i}`, content: "unrelated text about gardening" });
      embedNote(`other${i}`, 0.9 - i * 0.01);
    }
    embedNote("runbook", 0.3);
    const res = await searchAdjacent(db, "ws", "ERR-4021", 5, [], MODEL, embed);
    expect(res[0].noteId).toBe("runbook");
  });

  it("keeps the dense score for display and still returns dense-only matches", async () => {
    createNote(db, { id: "a", projectId: "p", workspaceId: "ws", title: "Alpha", content: "zzz" });
    embedNote("a", 0.8);
    const res = await searchAdjacent(db, "ws", "completely different words", 5, [], MODEL, embed);
    expect(res).toEqual([{ noteId: "a", title: "Alpha", score: 0.8, sectionTitle: "S0" }]);
  });

  it("finds a note that has no embedding yet via keywords, and honours excludeIds", async () => {
    createNote(db, { id: "fresh", projectId: "p", workspaceId: "ws", title: "Kubernetes ingress", content: "nginx" });
    createNote(db, { id: "old", projectId: "p", workspaceId: "ws", title: "Something", content: "x" });
    embedNote("old", 0.5);
    const res = await searchAdjacent(db, "ws", "kubernetes ingress", 5, [], MODEL, embed);
    expect(res.map((r) => r.noteId)).toContain("fresh");
    const ex = await searchAdjacent(db, "ws", "kubernetes ingress", 5, ["fresh"], MODEL, embed);
    expect(ex.map((r) => r.noteId)).not.toContain("fresh");
  });
});

describe("searchAdjacentTasks (hybrid)", () => {
  const card = (id: string, title: string, description = "") =>
    createCard(db, { id, columnId: "todo", projectId: "p", workspaceId: "ws", title, description });
  const embedCard = (id: string, cos: number) =>
    upsertTaskEmbedding(db, { cardId: id, sectionIdx: 0, sectionTitle: "S0", workspaceId: "ws", model: MODEL, task: "search_document", contentHash: id, vector: vec(cos) });

  it("finds a card by an exact reference and drops archived cards", async () => {
    card("ref", "Fix INC-88231 cert renewal");
    embedCard("ref", 0.2);
    for (let i = 0; i < 6; i++) {
      card(`t${i}`, `Task ${i}`, "misc");
      embedCard(`t${i}`, 0.9 - i * 0.01);
    }
    card("gone", "Fix INC-88231 again");
    embedCard("gone", 0.95);
    updateCard(db, "gone", { archivedAt: new Date().toISOString() } as never);
    const res = await searchAdjacentTasks(db, "ws", "INC-88231", 5, MODEL, embed);
    expect(res[0].cardId).toBe("ref");
    expect(res.map((r) => r.cardId)).not.toContain("gone");
  });
});
