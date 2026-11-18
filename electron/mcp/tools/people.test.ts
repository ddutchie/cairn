/**
 * The People tool and the People arguments on note/task tools, end to end
 * through the MCP executor (the same dispatcher chat uses), plus the privacy
 * rule: a private person's persona note is invisible to EVERY read tool.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import matter from "gray-matter";
import { applySchema } from "../../db/schema";
import { createWorkspace, createProject, createColumn, createNote, createCard } from "../../db/queries";
import {
  createPerson, getPerson, listAttendees, listPeople, setPeopleEnabled, updatePerson,
} from "../../db/people-queries";
import { findNoteFilePath } from "../../host-shared/notes-io";
import { executeTool } from "./index";
import { TOOL_SCHEMAS } from "../../lib/tool-schemas";
import { isCairnReadTool } from "../../../shared/agent/tool-names";

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let db: Database.Database;
let wp: string;
const run = async (name: string, args: Record<string, unknown>) => (await executeTool(db, wp, name, args)) as R;
const person = (name: string, extra: Partial<Parameters<typeof createPerson>[1]> = {}) => createPerson(db, { workspaceId: "ws", name, ...extra });
const meetingOf = (noteId: string) => (db.prepare("SELECT meeting_id FROM notes WHERE id = ?").get(noteId) as { meeting_id: string | null }).meeting_id;

beforeEach(() => {
  wp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-people-tool-"));
  db = new BetterSqlite3(":memory:");
  applySchema(db);
  createWorkspace(db, { id: "ws", name: "WS" });
  createProject(db, { id: "p", workspaceId: "ws", name: "Proj" });
  createColumn(db, { id: "c-back", projectId: "p", workspaceId: "ws", name: "Backlog", type: "backlog", order: 0 });
  createNote(db, { id: "n1", projectId: "p", workspaceId: "ws", title: "Weekly sync", content: "Notes" });
  createCard(db, { id: "k1", columnId: "c-back", projectId: "p", workspaceId: "ws", title: "Ship it" });
  setPeopleEnabled(db, true);
});

afterEach(() => {
  db.close();
  fs.rmSync(wp, { recursive: true, force: true });
});

describe("flag off", () => {
  it("the people tool refuses and People arguments are ignored", async () => {
    setPeopleEnabled(db, false);
    expect((await run("people", { action: "query" })).error).toMatch(/not turned on/);
    const r = await run("ensure_note", { projectId: "p", title: "Standup", content: "x", attendees: ["Ana"] });
    expect(r.error).toBeUndefined();
    expect(r.meeting).toBeUndefined();
    expect(meetingOf(r.id)).toBeNull();
  });
});

describe("people tool", () => {
  it("upsert creates, then merges aliases and emails into the same person", async () => {
    const a = await run("people", { action: "upsert", name: "Ana Ruiz", emails: ["ana@acme.io"], relationships: [{ type: "direct_report" }], cadence: "weekly" });
    expect(a.created).toBe(true);
    const b = await run("people", { action: "upsert", name: "ana ruiz", aliases: ["AR"], emails: ["ANA.R@acme.io"] });
    expect(b.updated).toBe(true);
    expect(b.person.id).toBe(a.person.id);
    const p = getPerson(db, a.person.id)!;
    expect(p.aliases).toEqual(["AR"]);
    expect(p.emails.sort()).toEqual(["ana.r@acme.io", "ana@acme.io"]);
    expect(p.cadence).toBe("weekly");
    expect(p.relationship.map((r) => r.type)).toEqual(["direct_report"]);
  });

  it("inferred facts go in as suggestions, and a dismissed person stays dismissed", async () => {
    const r = await run("people", { action: "upsert", name: "Sam Okafor", provenance: "inferred" });
    expect(getPerson(db, r.person.id)?.status).toBe("suggested");
    const gone = person("Pat Lee", { status: "dismissed" });
    await run("people", { action: "upsert", personId: gone.id, status: "confirmed" });
    expect(getPerson(db, gone.id)?.status).toBe("dismissed");
  });

  it("query filters by relationship and name; ambiguous names are an error", async () => {
    person("Ana Ruiz", { relationship: [{ type: "direct_report", provenance: "explicit" }] });
    person("Ben Ito", { relationship: [{ type: "peer", provenance: "explicit" }] });
    expect((await run("people", { action: "query", relationship: "direct_report" })).people.map((p: R) => p.name)).toEqual(["Ana Ruiz"]);
    expect((await run("people", { action: "query", name: "ito" })).people.map((p: R) => p.name)).toEqual(["Ben Ito"]);
    person("Chris");
    person("Chris");
    expect((await run("people", { action: "get", name: "Chris" })).error).toMatch(/more than one/);
  });

  it("link edge adds and removes a relationship, seen from both sides", async () => {
    const boss = person("Dana Boss");
    const ana = person("Ana Ruiz");
    await run("people", { action: "link", link: "edge", personId: boss.id, edgeType: "manager_of", otherPersonId: ana.id });
    const rel = await run("people", { action: "relationships", personId: ana.id });
    expect(rel.relations).toEqual([{ role: "reports_to", personId: boss.id, name: "Dana Boss" }]);
    expect((await run("people", { action: "relationships" })).edges).toEqual([
      { sourceId: boss.id, sourceName: "Dana Boss", type: "manager_of", targetId: ana.id, targetName: "Ana Ruiz" },
    ]);
    await run("people", { action: "link", link: "edge", personId: boss.id, edgeType: "manager_of", otherPersonId: ana.id, remove: true });
    expect((await run("people", { action: "relationships", personId: ana.id })).relations).toEqual([]);
  });

  it("link attendee makes the note a meeting and writes the frontmatter; timeline shows it", async () => {
    const ana = person("Ana Ruiz");
    await run("people", { action: "get", personId: ana.id }); // a read before anything exists
    const r = await run("people", { action: "link", link: "attendee", personId: ana.id, noteId: "n1" });
    expect(r.linked).toBe(true);
    const meetingId = meetingOf("n1")!;
    expect(listAttendees(db, meetingId).map((a) => [a.personId, a.source])).toEqual([[ana.id, "declared"]]);
    const t = await run("people", { action: "timeline", personId: ana.id });
    expect(t.meetings).toHaveLength(1);
    expect(t.meetings[0].notes).toEqual([{ id: "n1", title: "Weekly sync" }]);
  });
});

describe("People arguments on note and task tools", () => {
  it("ensure_note with attendees and date records the meeting and mirrors it into the file", async () => {
    const ana = person("Ana Ruiz");
    person("Chris");
    person("Chris");
    const r = await run("ensure_note", {
      projectId: "p", title: "1:1 Ana", content: "We talked.", attendees: [ana.id, "Chris", "Dana New"], date: "2026-11-10",
    });
    expect(r.error).toBeUndefined();
    expect(r.meeting.attendees).toEqual(["Ana Ruiz", "Dana New"]);
    expect(r.meeting.needsConfirming).toHaveLength(2);
    expect(r.meeting.newPeople).toEqual(["Dana New"]);
    const m = db.prepare("SELECT starts_at FROM meetings WHERE id = ?").get(meetingOf(r.id)) as { starts_at: string };
    expect(m.starts_at).toBe("2026-11-10T00:00:00.000Z");
    const file = findNoteFilePath(wp, "Proj", r.id)!;
    const fm = matter(fs.readFileSync(file, "utf-8")).data;
    // "Chris" is ambiguous: suggested in the app until confirmed, not written to the file.
    expect(fm.attendees).toEqual(["Ana Ruiz", "Dana New"]);
    expect(fm.date).toBe("2026-11-10");
  });

  it("update_notes replaces the declared attendees and can change only the date", async () => {
    const ana = person("Ana");
    const ben = person("Ben");
    await run("update_notes", { noteIds: ["n1"], attendees: ["Ana", "Ben"] });
    const second = await run("update_notes", { noteIds: ["n1"], attendees: ["Ana"] });
    expect(second.meeting.removed).toEqual(["Ben"]);
    await run("update_notes", { noteIds: ["n1"], date: "2026-12-01T09:30:00Z" });
    const meetingId = meetingOf("n1")!;
    expect(listAttendees(db, meetingId).map((a) => a.personId)).toEqual([ana.id]);
    expect(ben.id).toBeTruthy();
    const m = db.prepare("SELECT starts_at FROM meetings WHERE id = ?").get(meetingId) as { starts_at: string };
    expect(Date.parse(m.starts_at)).toBe(Date.parse("2026-12-01T09:30:00Z"));
  });

  it("a date alone doesn't turn a note into a meeting", async () => {
    const r = await run("update_notes", { noteIds: ["n1"], date: "2026-12-01" });
    expect(r.error).toBeUndefined();
    expect(meetingOf("n1")).toBeNull();
  });

  it("create_task and update_tasks set and clear the owner", async () => {
    const ana = person("Ana Ruiz", { emails: ["ana@acme.io"] });
    const c = await run("create_task", { projectId: "p", title: "Prep review", owner: "ana@acme.io" });
    expect(c.owner).toEqual({ id: ana.id, name: "Ana Ruiz" });
    const owner = (id: string) => (db.prepare("SELECT owner_person_id AS o FROM task_cards WHERE id = ?").get(id) as { o: string | null }).o;
    expect(owner(c.id)).toBe(ana.id);
    await run("update_tasks", { cardIds: [c.id, "k1"], owner: ana.id });
    expect(owner("k1")).toBe(ana.id);
    await run("update_tasks", { cardIds: ["k1"], owner: "" });
    expect(owner("k1")).toBeNull();
    expect((await run("update_tasks", { cardIds: ["k1"], owner: "Nobody Known" })).error).toMatch(/owner: No person named/);
  });
});

describe("private persona notes", () => {
  const SECRET = "ZQXJ-persona-secret";

  beforeEach(() => {
    createNote(db, { id: "n-private-ana", projectId: "p", workspaceId: "ws", title: "Ana Ruiz (private)", content: `Career notes ${SECRET}`, isPinned: true });
    // Another note links to it, so it shows up as a neighbour/link too.
    createNote(db, { id: "n3", projectId: "p", workspaceId: "ws", title: "Team", content: "See [[Ana Ruiz (private)]]" });
    const ana = person("Ana Ruiz", { personaNoteId: "n-private-ana" });
    updatePerson(db, ana.id, { agentPrivate: true });
  });

  /** Arguments that make each read tool return as much as it can. */
  const READ_CALLS: Record<string, Array<Record<string, unknown>>> = {
    get_context: [{}, { projectId: "p" }],
    get_item: [{ id: "n-private-ana" }, { id: "n3" }],
    search_notes: [{ query: "" }, { query: SECRET }, { query: "Ana" }, { query: "private", projectId: "p" }],
    search_tasks: [{ query: "" }],
    get_graph: [{}, { nodeId: "n3", depth: 2 }, { nodeId: "n-private-ana" }],
    get_idea_flow: [{ projectId: "p" }],
    get_user_writing_style: [{}],
    get_today: [{}],
    codebase_query: [{ action: "search", query: "x" }],
    people: [
      { action: "query" }, { action: "get", name: "Ana Ruiz" }, { action: "timeline", name: "Ana Ruiz" }, { action: "relationships" },
    ],
  };

  it("lists a call for every read tool (so a new read tool can't skip this test)", () => {
    const reads = Object.keys(TOOL_SCHEMAS).filter((n) => isCairnReadTool(n) || n === "people");
    expect(Object.keys(READ_CALLS).sort()).toEqual(reads.sort());
  });

  it("no read tool returns the note, its id or its text", async () => {
    for (const [name, calls] of Object.entries(READ_CALLS)) {
      for (const args of calls) {
        const out = JSON.stringify(await run(name, args));
        expect(out, `${name} ${JSON.stringify(args)}`).not.toContain(SECRET);
        expect(out, `${name} ${JSON.stringify(args)}`).not.toContain('"n-private-ana"');
      }
    }
  });

  it("the private person is still listed, without their note", async () => {
    const q = await run("people", { action: "query" });
    expect(q.people.map((p: R) => p.name)).toEqual(["Ana Ruiz"]);
    expect(q.people[0].personaNoteId).toBeUndefined();
    expect(listPeople(db, "ws")[0].personaNoteId).toBe("n-private-ana");
  });
});
