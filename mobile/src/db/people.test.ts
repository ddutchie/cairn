/** addNoteAttendee must not replace a note's calendar-meeting link with a fresh meeting while that meeting hasn't synced yet. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import BetterSqlite3 from "../../../vitest-sqlite-shim.cjs";
import type Database from "better-sqlite3";
import { MOBILE_SCHEMA_SQL, MOBILE_TRIGGERS_SQL } from "./schema";

const h = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("./index", () => ({
  getActiveSource: () => "ws1",
  getDb: () => ({ getAllSync: (sql: string, ...p: unknown[]) => h.db.prepare(sql).all(...p), getFirstSync: (sql: string, ...p: unknown[]) => h.db.prepare(sql).get(...p) ?? null }),
}));
vi.mock("./expo-sync-db", () => ({ createExpoSyncDb: () => h.db }));
vi.mock("@/sync/write-signal", () => ({ notifyLocalWrite: () => {} }));
vi.mock("./queries", () => ({ updateNote: () => {} }));

const {
  addNoteAttendee, setActionItemDone, loadOpenItems, saveProfile,
  createTeam, updateTeam, deleteTeam, mergeTeams, loadTeams, loadMemberships, addTeamMember, endTeamMember, saveTeamMembers, moveToTeam, mergePeople, loadPastTeams, loadTeamsView,
} = await import("./people");
const NOW = "2026-11-18T10:00:00.000Z";
const addNote = (id: string, content: string, extra = "") =>
  h.db.prepare(`INSERT INTO notes (id, project_id, workspace_id, title, content, created_at, updated_at${extra ? ", deleted_at" : ""}) VALUES (?, 'p1', 'ws1', 'Sync', ?, ?, ?${extra ? ", ?" : ""})`).run(...[id, content, NOW, NOW, ...(extra ? [extra] : [])]);

beforeEach(() => {
  h.db = new (BetterSqlite3 as unknown as new (f: string) => Database.Database)(":memory:");
  h.db.exec(MOBILE_SCHEMA_SQL);
  h.db.exec(MOBILE_TRIGGERS_SQL);
  const now = "2026-11-18T10:00:00.000Z";
  h.db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws1', 'W', ?, ?)").run(now, now);
  h.db.prepare("INSERT INTO people (id, workspace_id, name, aliases, emails, created_at, updated_at) VALUES ('ana', 'ws1', 'Ana Ruiz', '[]', '[]', ?, ?)").run(now, now);
});

describe("addNoteAttendee", () => {
  it("refuses, retryably, when the note's meeting row hasn't synced", () => {
    h.db.prepare("INSERT INTO notes (id, project_id, workspace_id, title, content, meeting_id, created_at, updated_at) VALUES ('n1', 'p1', 'ws1', 'Sync', 'x', 'cal:future', ?, ?)").run("2026-11-18T10:00:00.000Z", "2026-11-18T10:00:00.000Z");
    expect(() => addNoteAttendee("n1", "ana")).toThrow(/hasn't synced/);
    expect(h.db.prepare("SELECT meeting_id AS m FROM notes WHERE id='n1'").get()).toEqual({ m: "cal:future" });
  });

  it("a rejected add leaves the note unlinked", () => {
    addNote("n1", "x");
    expect(() => addNoteAttendee("n1", "nobody")).toThrow(/Person not found/);
    expect(h.db.prepare("SELECT meeting_id AS m FROM notes WHERE id='n1'").get()).toEqual({ m: null });
  });

  it("refuses a deleted note", () => {
    addNote("n1", "x", NOW);
    expect(() => addNoteAttendee("n1", "ana")).toThrow(/gone/);
  });

  it("gives a restored note whose meeting was deleted a fresh meeting", () => {
    addNote("n1", "x");
    h.db.prepare("INSERT INTO meetings (id, workspace_id, title, starts_at, source, created_at, updated_at, deleted_at) VALUES ('nmt:old', 'ws1', 'Sync', ?, 'note', ?, ?, ?)").run(NOW, NOW, NOW, NOW);
    h.db.prepare("UPDATE notes SET meeting_id = 'nmt:old' WHERE id = 'n1'").run();
    expect(addNoteAttendee("n1", "ana").personId).toBe("ana");
    expect((h.db.prepare("SELECT meeting_id AS m FROM notes WHERE id='n1'").get() as { m: string }).m).not.toBe("nmt:old");
  });
});

describe("open items", () => {
  it("skips templates and refuses a tick against a note body that changed since listing", () => {
    addNote("n1", "- [ ] **Ana Ruiz** - draft the plan\n");
    h.db.prepare("INSERT INTO notes (id, project_id, workspace_id, title, content, type, created_at, updated_at) VALUES ('t1', 'p1', 'ws1', 'Tpl', '- [ ] **Ana Ruiz** - template task', 'template', ?, ?)").run(NOW, NOW);
    const ana = { id: "ana", workspaceId: "ws1", personaNoteId: null } as never;
    const items = loadOpenItems(ana).theyOwe;
    expect(items.map((i) => i.noteId)).toEqual(["n1"]);
    h.db.prepare("UPDATE notes SET content = ? WHERE id = 'n1'").run("- [ ] **Ana Ruiz** - something else\n- [ ] **Ana Ruiz** - draft the plan\n");
    expect(setActionItemDone("n1", items[0].lineKey, true, items[0].bodyDigest)).toBe(false);
    const fresh = loadOpenItems(ana).theyOwe;
    expect(setActionItemDone("n1", fresh[0].lineKey, true, fresh[0].bodyDigest)).toBe(true);
  });
});

describe("saveProfile", () => {
  const edit = { title: "Senior Engineer", team: "Sync", location: "Berlin", timezone: "Europe/Berlin", slackId: "U01ABC" };
  it("stores the fields and clears a blank one", () => {
    const saved = saveProfile("ana", edit);
    expect(h.db.prepare("SELECT title, location, timezone, slack_id AS s FROM people WHERE id='ana'").get())
      .toEqual({ title: "Senior Engineer", location: "Berlin", timezone: "Europe/Berlin", s: "U01ABC" });
    // The team is a membership of a team row, not a column.
    expect(saved.team).toBe("Sync");
    const cleared = saveProfile("ana", { team: "  " });
    expect(cleared).toMatchObject({ title: "Senior Engineer", team: undefined, teams: [] });
  });
});

describe("teams", () => {
  const person = (id: string, name: string) =>
    h.db.prepare("INSERT INTO people (id, workspace_id, name, aliases, emails, created_at, updated_at) VALUES (?, 'ws1', ?, '[]', '[]', ?, ?)").run(id, name, NOW, NOW);

  it("makes, edits and lists a team in the active workspace", () => {
    const team = createTeam({ name: "  Sync  ", kind: "guild", description: "The sync engine" });
    expect(team).toMatchObject({ name: "Sync", kind: "guild", workspaceId: "ws1" });
    expect(updateTeam(team.id, { channel: "#sync", links: [{ label: "Board", url: "https://example.com" }] })).toMatchObject({ channel: "#sync" });
    expect(loadTeams().map((t) => t.name)).toEqual(["Sync"]);
    expect(() => createTeam({ name: "sync" })).toThrow(/already a team/);
    expect(() => updateTeam(team.id, { parentTeamId: team.id })).toThrow(/under itself/);
  });

  it("adds, re-roles and ends members, and keeps the ended stint", () => {
    const team = createTeam({ name: "Sync" });
    addTeamMember({ teamId: team.id, personId: "ana", role: "Tech lead" });
    addTeamMember({ teamId: team.id, personId: "ana", role: null });
    expect(loadMemberships()[0]).toMatchObject({ personId: "ana", role: undefined, endedAt: undefined });
    endTeamMember(team.id, "ana");
    expect(loadMemberships()[0].endedAt).toBeTruthy();
  });

  it("saves member edits together: one failing leaves none of them saved", () => {
    const team = createTeam({ name: "Sync" });
    addTeamMember({ teamId: team.id, personId: "ana" });
    expect(() => saveTeamMembers({ teamId: team.id, end: ["ana"], set: [{ personId: "gone", role: null }] })).toThrow(/Person not found/);
    expect(loadMemberships().find((m) => m.personId === "ana")?.endedAt).toBeUndefined();
    saveTeamMembers({ teamId: team.id, end: ["ana"], set: [] });
    expect(loadMemberships().find((m) => m.personId === "ana")?.endedAt).toBeTruthy();
  });

  it("moves someone to a new team, leaving the old one, and refuses a guild as a home team", () => {
    const old = createTeam({ name: "Old" });
    createTeam({ name: "Guild", kind: "guild" });
    addTeamMember({ teamId: old.id, personId: "ana" });
    moveToTeam("ana", "Fresh");
    expect(loadMemberships().filter((m) => !m.endedAt).map((m) => m.teamId)).toHaveLength(1);
    expect(loadMemberships().find((m) => m.teamId === old.id)?.endedAt).toBeTruthy();
    expect(() => moveToTeam("ana", "Guild")).toThrow(/not a team/);
  });

  it("merges teams and deletes one, moving its sub-teams up", () => {
    const top = createTeam({ name: "Top" });
    const mid = createTeam({ name: "Mid", parentTeamId: top.id });
    const leaf = createTeam({ name: "Leaf", parentTeamId: mid.id });
    addTeamMember({ teamId: mid.id, personId: "ana" });
    deleteTeam(mid.id);
    expect(loadTeams().find((t) => t.id === leaf.id)?.parentTeamId).toBe(top.id);
    expect(loadMemberships()).toEqual([]);
    const twin = createTeam({ name: "Leaf two" });
    addTeamMember({ teamId: twin.id, personId: "ana" });
    mergeTeams(leaf.id, twin.id);
    expect(loadMemberships().map((m) => m.teamId)).toEqual([leaf.id]);
  });

  it("merges two people: the other name becomes an alias and their teams move", () => {
    person("sam", "Sam");
    const team = createTeam({ name: "Sync" });
    addTeamMember({ teamId: team.id, personId: "sam" });
    const { person: kept } = mergePeople("ana", "sam");
    expect(kept.aliases).toContain("Sam");
    expect(loadMemberships().map((m) => m.personId)).toEqual(["ana"]);
    expect(h.db.prepare("SELECT deleted_at AS d FROM people WHERE id = 'sam'").get()).toEqual({ d: expect.any(String) });
  });

  it("lists teams someone has left, but not ones they are back on", () => {
    const a = createTeam({ name: "A" });
    const b = createTeam({ name: "B" });
    addTeamMember({ teamId: a.id, personId: "ana" });
    addTeamMember({ teamId: b.id, personId: "ana" });
    endTeamMember(a.id, "ana");
    expect(loadPastTeams("ana", [{ teamId: b.id }]).map((p) => p.team.name)).toEqual(["A"]);
    addTeamMember({ teamId: a.id, personId: "ana" });
    expect(loadPastTeams("ana", [{ teamId: a.id }, { teamId: b.id }])).toEqual([]);
  });

  it("reads the team tree with people under their teams and the rest without one", () => {
    person("bo", "Bo");
    const top = createTeam({ name: "Top" });
    createTeam({ name: "Sub", parentTeamId: top.id });
    addTeamMember({ teamId: top.id, personId: "ana" });
    const view = loadTeamsView();
    expect(view.forest.map((n) => [n.group.team, n.children.map((c) => c.group.team)])).toEqual([["Top", ["Sub"]]]);
    expect(view.groups.find((g) => g.key === "_none")?.people.map((p) => p.id)).toEqual(["bo"]);
  });
});
