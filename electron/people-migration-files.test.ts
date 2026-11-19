/**
 * The migration against real note files: the inventory reads frontmatter Cairn
 * doesn't store, an approved meeting gets its `attendees`/`date` frontmatter
 * through the normal refresh path, and nothing else in any file changes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import type Database from "better-sqlite3";
import { makeDb, seedProject, seedWorkspace } from "./test-support/db";
import { createNote } from "./db/notes-queries";
import { setPeopleEnabled } from "./db/people-queries";
import { applyMigration, buildInventory } from "./db/people-migration";
import { findNoteFilePath, writeNoteFile } from "./host-shared/notes-io";
import { makeFrontmatterReader, refreshMeetingFrontmatter } from "./people-files";

let db: Database.Database;
let ws: string;

beforeEach(() => {
  db = makeDb();
  seedWorkspace(db);
  seedProject(db);
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-people-migration-"));
});
afterEach(() => {
  db.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

function noteFile(id: string, title: string, folder: string, body: string, extra: Record<string, unknown> = {}) {
  const n = createNote(db, { id, projectId: "proj1", workspaceId: "ws1", title, content: body, folder });
  writeNoteFile(ws, { id, projectId: "proj1", workspaceId: "ws1", title, content: body, folder, tagIds: [], linkedNoteIds: [], linkedCardIds: [], isPinned: false, createdAt: n.createdAt, updatedAt: n.updatedAt, projectName: "Test Project" });
  const file = findNoteFilePath(ws, "Test Project", id)!;
  if (Object.keys(extra).length) {
    const parsed = matter(fs.readFileSync(file, "utf-8"));
    fs.writeFileSync(file, matter.stringify(parsed.content, { ...parsed.data, ...extra }));
  }
  return file;
}

describe("migration with note files", () => {
  it("reads frontmatter, writes only the meeting's attendees and date, and a re-run writes nothing", () => {
    const personaFile = noteFile("pa", "Ana Ruiz", "People", "Eng.\n", { type: "person", aliases: ["Anita"], email: "ana@example.com" });
    const benFile = noteFile("pb", "Ben Okafor", "People", "Backend.\n", { tags: ["person"] });
    const meetingFile = noteFile("mt", "Sync", "Meetings", "**Attendees:** Ana Ruiz, Ben Okafor\n**When:** 2026-11-03\n\nNotes.\n");
    const journalFile = noteFile("jn", "Journal", "Journal", "Quiet.\n", { date: "2026-11-01" });
    const readFrontmatter = makeFrontmatterReader(db, ws, "ws1");

    const inv = buildInventory(db, "ws1", { readFrontmatter });
    expect(inv.personas.map((p) => [p.name, p.confidence, p.aliases, p.emails])).toEqual([
      ["Ana Ruiz", "high", ["Anita"], ["ana@example.com"]], // frontmatter type, alias and email
      ["Ben Okafor", "high", [], []], // frontmatter tags
    ]);
    expect(inv.meetings.map((m) => m.noteId)).toEqual(["mt"]);

    setPeopleEnabled(db, true);
    const filesBefore = new Map([personaFile, benFile, meetingFile, journalFile].map((f) => [f, fs.readFileSync(f, "utf-8")]));
    const approvals = { personas: inv.personas.map((p) => ({ noteId: p.noteId })), meetings: ["mt"] };
    const refresh = (ids: string[]) => refreshMeetingFrontmatter(db, ws, ids).written;

    const preview = applyMigration(db, "ws1", approvals, { dryRun: true, readFrontmatter, refreshFrontmatter: refresh });
    expect(preview.frontmatterNotes).toEqual(["mt"]);
    for (const [f, text] of filesBefore) expect(fs.readFileSync(f, "utf-8")).toBe(text); // dry run: no file written

    const r = applyMigration(db, "ws1", approvals, { readFrontmatter, refreshFrontmatter: refresh });
    expect(r.frontmatterNotes).toEqual(["mt"]);
    const fm = matter(fs.readFileSync(meetingFile, "utf-8"));
    expect(fm.data.attendees).toEqual(["[[Ana Ruiz]]", "[[Ben Okafor]]"]);
    expect(String(fm.data.date).slice(0, 10)).toBe("2026-11-03");
    expect(fm.content.trim()).toBe(matter(filesBefore.get(meetingFile)!).content.trim()); // body untouched, "When:" line stays
    for (const f of [personaFile, benFile, journalFile]) expect(fs.readFileSync(f, "utf-8")).toBe(filesBefore.get(f)); // persona and journal notes untouched

    const afterFirst = fs.readFileSync(meetingFile, "utf-8");
    const again = applyMigration(db, "ws1", approvals, { readFrontmatter, refreshFrontmatter: refresh });
    expect(again.frontmatterNotes).toEqual([]);
    expect(fs.readFileSync(meetingFile, "utf-8")).toBe(afterFirst);
  });

  it("writes no file while the flag is off", () => {
    const meetingFile = noteFile("mt", "Sync", "Meetings", "**Attendees:** Ana Ruiz\n");
    const before = fs.readFileSync(meetingFile, "utf-8");
    const r = applyMigration(db, "ws1", { meetings: ["mt"] }, { refreshFrontmatter: (ids) => refreshMeetingFrontmatter(db, ws, ids).written });
    expect(r.applied).toBe(false);
    expect(fs.readFileSync(meetingFile, "utf-8")).toBe(before);
  });
});
