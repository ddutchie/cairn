/**
 * Incremental auto-relationships must leave relationship_cache exactly as a
 * full recompute would, for every kind of edit a save can make.
 */

import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { buildGraphFixture } from "./bench/graph-fixture";
import { computeAutoRelationships, resetAutoRelationshipCache } from "./auto-relationships";
import { createNote, updateNote, updateCard, deleteNote, rewriteInboundWikilinks } from "./queries";

type CacheRow = { source_id: string; target_id: string; type: string; weight: number };

/** Non-semantic rows whose endpoints are both live (what the graph can show). */
function liveRows(db: Database.Database, workspaceId: string): string[] {
  const live = new Set(
    (db.prepare(
      `SELECT id FROM notes WHERE workspace_id = ? AND archived_at IS NULL AND deleted_at IS NULL
       UNION ALL
       SELECT id FROM task_cards WHERE workspace_id = ? AND archived_at IS NULL AND deleted_at IS NULL`,
    ).all(workspaceId, workspaceId) as { id: string }[]).map((r) => r.id),
  );
  return (db.prepare("SELECT source_id, target_id, type, weight FROM relationship_cache WHERE type != 'semantic'").all() as CacheRow[])
    .filter((r) => live.has(r.source_id) && live.has(r.target_id))
    .map((r) => `${r.type} ${r.source_id} ${r.target_id} ${r.weight}`)
    .sort();
}

/** Rows a from-scratch full pass produces for the DB's current content. */
function expectedRows(db: Database.Database, workspaceId: string): string[] {
  const saved = db.prepare("SELECT * FROM relationship_cache").all();
  db.prepare("DELETE FROM relationship_cache").run();
  resetAutoRelationshipCache(db);
  computeAutoRelationships(db, workspaceId);
  const rows = liveRows(db, workspaceId);
  db.prepare("DELETE FROM relationship_cache").run();
  const insert = db.prepare(
    `INSERT INTO relationship_cache (source_id, target_id, type, weight, computed_at, source_section_title, target_section_title)
     VALUES (@source_id, @target_id, @type, @weight, @computed_at, @source_section_title, @target_section_title)`,
  );
  for (const r of saved) insert.run(r);
  return rows;
}

function setup() {
  const f = buildGraphFixture({ notes: 120, avgNoteBytes: 800, seed: 7 });
  // The fixture pre-fills relationship_cache with synthetic edges; start from real ones.
  f.db.prepare("DELETE FROM relationship_cache").run();
  computeAutoRelationships(f.db, f.workspaceId);
  return f;
}

function titleOf(db: Database.Database, id: string): string {
  return (db.prepare("SELECT title FROM notes WHERE id = ? UNION ALL SELECT title FROM task_cards WHERE id = ?").get(id, id) as { title: string }).title;
}

describe("computeAutoRelationships — incremental matches a full recompute", () => {
  it("after editing a note's body (new mentions, wikilinks, keywords)", () => {
    const f = setup();
    const [a, b, c] = [f.noteIds[3], f.noteIds[40], f.noteIds[77]];
    updateNote(f.db, a, {
      content: `Rewritten. Mentions ${titleOf(f.db, b)} and links [[${titleOf(f.db, c)}]]. ${titleOf(f.db, f.cardIds[2])}.`,
    });
    computeAutoRelationships(f.db, f.workspaceId, [a]);
    expect(liveRows(f.db, f.workspaceId)).toEqual(expectedRows(f.db, f.workspaceId));
  });

  it("after renaming a note that other notes mention", () => {
    const f = setup();
    const target = f.noteIds[10];
    const oldTitle = titleOf(f.db, target);
    // Make sure someone mentions both the old and the new title.
    updateNote(f.db, f.noteIds[20], { content: `About ${oldTitle} and also Brand New Title Here.` });
    computeAutoRelationships(f.db, f.workspaceId, [f.noteIds[20]]);
    updateNote(f.db, target, { title: "Brand New Title Here" });
    computeAutoRelationships(f.db, f.workspaceId, [target]);
    expect(liveRows(f.db, f.workspaceId)).toEqual(expectedRows(f.db, f.workspaceId));
  });

  it("after creating a note whose title others already mention", () => {
    const f = setup();
    updateNote(f.db, f.noteIds[5], { content: "Waiting on the Quarterly Planning Memo and [[Quarterly Planning Memo]]." });
    computeAutoRelationships(f.db, f.workspaceId, [f.noteIds[5]]);
    createNote(f.db, { id: "new-note", projectId: "proj-0", workspaceId: f.workspaceId, title: "Quarterly Planning Memo", content: "Draft." });
    computeAutoRelationships(f.db, f.workspaceId, ["new-note"]);
    expect(liveRows(f.db, f.workspaceId)).toEqual(expectedRows(f.db, f.workspaceId));
  });

  it("after changing a card's assignee and title", () => {
    const f = setup();
    const card = f.cardIds[4];
    updateCard(f.db, card, { assignee: "sam", title: "Renamed Card Title" });
    computeAutoRelationships(f.db, f.workspaceId, [card]);
    expect(liveRows(f.db, f.workspaceId)).toEqual(expectedRows(f.db, f.workspaceId));
  });

  it("after several saves in a row, including two notes changed together", () => {
    const f = setup();
    for (let i = 0; i < 6; i++) {
      const [x, y] = [f.noteIds[i * 13 % 120], f.noteIds[(i * 29 + 7) % 120]];
      updateNote(f.db, x, { content: `Edit ${i}: ${titleOf(f.db, y)} [[${titleOf(f.db, y)}]] shared words planning roadmap` });
      updateNote(f.db, y, { content: `Edit ${i}: shared words planning roadmap ${titleOf(f.db, f.noteIds[i])}` });
      computeAutoRelationships(f.db, f.workspaceId, [x, y]);
    }
    expect(liveRows(f.db, f.workspaceId)).toEqual(expectedRows(f.db, f.workspaceId));
  });

  it("finds mentions of titles with LIKE wildcards or no ASCII words", () => {
    const f = setup();
    updateNote(f.db, f.noteIds[1], { content: "Status: 100%_done report is out. See [[Überblick Ärger]] and Überblick Ärger." });
    computeAutoRelationships(f.db, f.workspaceId, [f.noteIds[1]]);
    createNote(f.db, { id: "pct", projectId: "proj-0", workspaceId: f.workspaceId, title: "100%_done report", content: "x" });
    createNote(f.db, { id: "uml", projectId: "proj-0", workspaceId: f.workspaceId, title: "Überblick Ärger", content: "y" });
    computeAutoRelationships(f.db, f.workspaceId, ["pct", "uml"]);
    const rows = liveRows(f.db, f.workspaceId);
    expect(rows.some((r) => r.startsWith("co-mention") && r.includes("pct"))).toBe(true);
    expect(rows.some((r) => r.startsWith("wikilink") && r.includes("uml"))).toBe(true);
    expect(rows).toEqual(expectedRows(f.db, f.workspaceId));
  });

  it("after a rename that relinks other notes' [[wikilinks]]", () => {
    const f = setup();
    const target = f.noteIds[15];
    const oldTitle = titleOf(f.db, target);
    for (const i of [30, 31]) updateNote(f.db, f.noteIds[i], { content: `Depends on [[${oldTitle}]] heavily.` });
    // Q shares the new title's words, so the relinked bodies' keyword pairs with Q change.
    updateNote(f.db, f.noteIds[32], { content: "depends heavily renamed target extra" });
    computeAutoRelationships(f.db, f.workspaceId, [f.noteIds[30], f.noteIds[31], f.noteIds[32]]);
    updateNote(f.db, target, { title: "Renamed Target Note" });
    const relinked = rewriteInboundWikilinks(f.db, target, [oldTitle], "Renamed Target Note");
    expect(relinked.length).toBe(2);
    computeAutoRelationships(f.db, f.workspaceId, [target, ...relinked.map((r) => r.id)]);
    expect(liveRows(f.db, f.workspaceId)).toEqual(expectedRows(f.db, f.workspaceId));
  });

  it("after a large batch (one shared scan of every body)", () => {
    const f = setup();
    const batch = f.noteIds.slice(50, 80);
    for (const [i, id] of batch.entries()) {
      updateNote(f.db, id, { title: `Batch Moved Note ${i}`, content: `Moved. See Batch Moved Note ${(i + 1) % batch.length}.` });
    }
    computeAutoRelationships(f.db, f.workspaceId, batch);
    expect(liveRows(f.db, f.workspaceId)).toEqual(expectedRows(f.db, f.workspaceId));
  });

  it("finds mentions of a title in a caseless script", () => {
    const f = setup();
    updateNote(f.db, f.noteIds[6], { content: "今日の会議記録を参照 [[会議記録メモ]]" });
    computeAutoRelationships(f.db, f.workspaceId, [f.noteIds[6]]);
    createNote(f.db, { id: "cjk", projectId: "proj-0", workspaceId: f.workspaceId, title: "会議記録メモ", content: "z" });
    computeAutoRelationships(f.db, f.workspaceId, ["cjk"]);
    const rows = liveRows(f.db, f.workspaceId);
    expect(rows.some((r) => r.startsWith("wikilink") && r.includes("cjk"))).toBe(true);
    expect(rows).toEqual(expectedRows(f.db, f.workspaceId));
  });

  it("after deleting a note", () => {
    const f = setup();
    deleteNote(f.db, f.noteIds[2]);
    computeAutoRelationships(f.db, f.workspaceId, [f.noteIds[9]]);
    expect(liveRows(f.db, f.workspaceId)).toEqual(expectedRows(f.db, f.workspaceId));
  });
});
