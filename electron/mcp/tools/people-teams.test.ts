/**
 * Teams (sync protocol 7): team rows with fixed ids, memberships with roles
 * and history, merging teams and people, adopting the old free-text team, the
 * one rule for chips and edges to you, and the `people` tool's team actions.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type Database from "better-sqlite3";
import { makeDb } from "../../test-support/db";
import { createWorkspace } from "../../db/queries";
import { addAttendee, addEdge, createMeeting, createPerson, getPerson, getRelations, listAttendees, mergePeople, updateEdge, updatePerson } from "../../db/people-queries";
import {
  addMember, createTeam, deleteTeam, endMember, getTeam, listMemberships, listTeams, mergeTeams, setHomeTeam, updateTeam,
} from "../../../shared/people/team-queries";
import { adoptPeopleStructure } from "../../../shared/people/adopt";
import { edgeRowId } from "../../../shared/people/ids";
import { executeTool } from "./index";

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let db: Database.Database;
let wp: string;
const run = async (args: Record<string, unknown>) => (await executeTool(db, wp, "people", args)) as R;
const person = (name: string, team?: string) => createPerson(db, { workspaceId: "ws", name, team });

beforeEach(() => {
  wp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-people-teams-"));
  db = makeDb();
  createWorkspace(db, { id: "ws", name: "WS" });
});
afterEach(() => {
  db.close();
  fs.rmSync(wp, { recursive: true, force: true });
});

describe("team queries", () => {
  it("gives a team an id from its name, so two devices making it make one row", () => {
    const t = createTeam(db, { workspaceId: "ws", name: "Sync  Team" });
    expect(t.id).toBe("team:ws:sync team");
  });

  it("a rename touches only the team row; members stay on it", () => {
    const ann = person("Ann", "Sync");
    const t = getPerson(db, ann.id)!.teams[0];
    db.prepare("DELETE FROM sync_pending").run();
    updateTeam(db, t.teamId, { name: "Replication" });
    expect(getPerson(db, ann.id)!.team).toBe("Replication");
    expect(db.prepare("SELECT entity FROM sync_pending").all()).toEqual([{ entity: "teams" }]);
  });

  it("a new team whose name's id is held by a renamed team takes the next id", () => {
    const a = createTeam(db, { workspaceId: "ws", name: "Sync" });
    updateTeam(db, a.id, { name: "Core" });
    const b = createTeam(db, { workspaceId: "ws", name: "Sync" });
    expect(b.id).toBe("team:ws:sync~2");
  });

  it("refuses a duplicate name and a parent cycle", () => {
    const a = createTeam(db, { workspaceId: "ws", name: "Platform" });
    const b = createTeam(db, { workspaceId: "ws", name: "Sync", parentTeamId: a.id });
    expect(() => createTeam(db, { workspaceId: "ws", name: "platform" })).toThrow(/already a team/);
    expect(() => updateTeam(db, a.id, { parentTeamId: b.id })).toThrow(/under itself/);
  });

  it("someone can be on a team and a guild; moving home ends only the other team", () => {
    const ann = person("Ann", "Sync");
    const guild = createTeam(db, { workspaceId: "ws", name: "Frontend guild", kind: "guild" });
    addMember(db, { teamId: guild.id, personId: ann.id, role: "Organiser" });
    setHomeTeam(db, ann.id, "Platform");
    const p = getPerson(db, ann.id)!;
    expect(p.team).toBe("Platform");
    expect(p.teams.map((t) => [t.name, t.role ?? null])).toEqual([["Platform", null], ["Frontend guild", "Organiser"]]);
    const sync = listMemberships(db, "ws").find((m) => m.teamId === "team:ws:sync")!;
    expect(sync.endedAt).toBeTruthy();
  });

  it("joining again after leaving starts a new stint", () => {
    const ann = person("Ann");
    const t = createTeam(db, { workspaceId: "ws", name: "Sync" });
    addMember(db, { teamId: t.id, personId: ann.id, startedAt: "2026-01-01" });
    endMember(db, t.id, ann.id, "2026-03-01");
    expect(getPerson(db, ann.id)!.teams).toEqual([]);
    const again = addMember(db, { teamId: t.id, personId: ann.id });
    expect(again.endedAt).toBeUndefined();
    expect(again.startedAt! > "2026-03-01").toBe(true);
  });

  it("delete removes its memberships and moves child teams up", () => {
    const ann = person("Ann", "Sync");
    const root = createTeam(db, { workspaceId: "ws", name: "Platform" });
    const mid = getTeam(db, "team:ws:sync")!;
    updateTeam(db, mid.id, { parentTeamId: root.id });
    const leaf = createTeam(db, { workspaceId: "ws", name: "Mobile sync", parentTeamId: mid.id });
    deleteTeam(db, mid.id);
    expect(getPerson(db, ann.id)!.team).toBeUndefined();
    expect(getTeam(db, leaf.id)!.parentTeamId).toBe(root.id);
    expect(listTeams(db, "ws").map((t) => t.name)).toEqual(["Mobile sync", "Platform"]);
  });

  it("lists two teams that share a name, and merging folds members and details into one", () => {
    const a = createTeam(db, { workspaceId: "ws", name: "Sync" });
    const b = createTeam(db, { workspaceId: "ws", name: "Core", channel: "#core" });
    updateTeam(db, a.id, { name: "Replication" });
    updateTeam(db, b.id, { name: "Replication2" });
    // Two devices renamed different teams to one name before they synced.
    db.prepare("UPDATE teams SET name = 'Replication' WHERE id = ?").run(b.id);
    const ann = person("Ann");
    const bo = person("Bo");
    addMember(db, { teamId: a.id, personId: ann.id });
    addMember(db, { teamId: b.id, personId: bo.id, role: "Tech lead" });
    expect(listTeams(db, "ws").filter((t) => t.name === "Replication")).toHaveLength(2);
    mergeTeams(db, a.id, b.id);
    expect(getTeam(db, b.id)).toBeNull();
    expect(getTeam(db, a.id)!.channel).toBe("#core");
    expect(getPerson(db, bo.id)!.teams).toMatchObject([{ teamId: a.id, role: "Tech lead" }]);
  });
});

describe("adoption", () => {
  it("turns the old free-text team into memberships once, and chips into edges to you", () => {
    const me = createPerson(db, { workspaceId: "ws", name: "Me", isMe: true });
    const ann = createPerson(db, { workspaceId: "ws", name: "Ann" });
    // Rows as the first People builds wrote them.
    db.prepare("UPDATE people SET team = 'sync', relationship = ? WHERE id = ?").run(JSON.stringify([{ type: "direct_report", provenance: "explicit" }]), ann.id);
    db.prepare("DELETE FROM person_edges").run();
    const first = adoptPeopleStructure(db);
    expect(first).toEqual({ memberships: 1, edges: 1 });
    expect(getPerson(db, ann.id)!.team).toBe("sync");
    expect(getRelations(db, ann.id).map((r) => [r.role, r.otherId])).toEqual([["reports_to", me.id]]);
    expect(adoptPeopleStructure(db)).toEqual({ memberships: 0, edges: 0 });
  });
});

describe("chips and edges to you", () => {
  it("a manager chip writes the edge, taking it off ends it, and an ended edge hides the chip", () => {
    const me = createPerson(db, { workspaceId: "ws", name: "Me", isMe: true });
    const boss = createPerson(db, { workspaceId: "ws", name: "Boss", relationship: [{ type: "manager", provenance: "explicit" }] });
    const id = edgeRowId("manager_of", boss.id, me.id);
    expect(getRelations(db, boss.id)[0].edge.id).toBe(id);
    updatePerson(db, boss.id, { relationship: [] });
    expect(getRelations(db, boss.id)[0].edge.endedAt).toBeTruthy();
    // Back as my manager: the chip makes the edge current again.
    updatePerson(db, boss.id, { relationship: [{ type: "manager", provenance: "explicit" }] });
    expect(getRelations(db, boss.id)[0].edge.endedAt).toBeUndefined();
    // Ending the edge directly takes the chip away.
    updateEdge(db, id, { endedAt: "2026-06-01" });
    expect(getPerson(db, boss.id)!.relationship).toEqual([]);
  });

  it("adding an ended edge again makes it current", () => {
    const a = person("A");
    const b = person("B");
    addEdge(db, { workspaceId: "ws", sourceId: a.id, targetId: b.id, type: "manager_of", endedAt: "2026-01-01" });
    const e = addEdge(db, { workspaceId: "ws", sourceId: a.id, targetId: b.id, type: "manager_of" });
    expect(e.endedAt).toBeUndefined();
  });
});

describe("merging people", () => {
  it("moves meetings, edges and teams to who stays, and the other name becomes an alias", () => {
    const sam = person("Sam Whitfield", "Sync");
    const stub = createPerson(db, { workspaceId: "ws", name: "Sam", status: "suggested", emails: ["sam@x.io"] });
    const lee = person("Lee");
    const m = createMeeting(db, { workspaceId: "ws", title: "1:1", startsAt: "2026-11-01T10:00:00Z" });
    addAttendee(db, { meetingId: m.id, personId: stub.id, source: "frontmatter" });
    addEdge(db, { workspaceId: "ws", sourceId: lee.id, targetId: stub.id, type: "manager_of" });
    const t = createTeam(db, { workspaceId: "ws", name: "Guild", kind: "guild" });
    addMember(db, { teamId: t.id, personId: stub.id });
    const { person: kept } = mergePeople(db, sam.id, stub.id);
    expect(getPerson(db, stub.id)).toBeNull();
    expect(kept.aliases).toContain("Sam");
    expect(kept.emails).toContain("sam@x.io");
    expect(kept.teams.map((x) => x.name).sort()).toEqual(["Guild", "Sync"]);
    expect(listAttendees(db, m.id).map((a) => a.personId)).toEqual([sam.id]);
    expect(getRelations(db, sam.id).map((r) => [r.role, r.otherId])).toEqual([["reports_to", lee.id]]);
  });
});

describe("people tool: teams", () => {
  it("team_upsert creates a team with details and members, and teams reads it back", async () => {
    const ann = person("Ann Lee");
    person("Bo Chen");
    createTeam(db, { workspaceId: "ws", name: "Platform" });
    const out = await run({
      action: "team_upsert", team: "Sync",
      teamInfo: { description: "Owns replication", lead: "Ann Lee", parentTeam: "Platform", channel: "#sync", members: ["Bo Chen"], role: "Engineer", links: [{ url: "https://example.com/board" }] },
    });
    expect(out.created).toBe(true);
    expect(out.addedMembers.sort()).toEqual(["Ann Lee", "Bo Chen"]);
    const read = await run({ action: "teams", team: "sync" });
    expect(read).toMatchObject({
      name: "Sync", description: "Owns replication", channel: "#sync", parentTeam: "Platform",
      lead: { id: ann.id, name: "Ann Lee" }, links: [{ label: "example.com", url: "https://example.com/board" }],
    });
    expect(read.members.map((m: R) => [m.name, m.role ?? null])).toEqual([["Ann Lee", null], ["Bo Chen", "Engineer"]]);
  });

  it("an unknown parent team is an error, not a new team", async () => {
    const out = await run({ action: "team_upsert", team: "Sync", teamInfo: { parentTeam: "Platfrom" } });
    expect(out.error).toMatch(/parentTeam/);
    expect(listTeams(db, "ws")).toEqual([]);
  });

  it("removeMembers keeps the stint as a past member; team_delete removes the team", async () => {
    person("Ann", "Sync");
    await run({ action: "team_upsert", team: "Sync", teamInfo: { removeMembers: ["Ann"] } });
    const read = await run({ action: "teams", team: "Sync" });
    expect(read.members).toEqual([]);
    expect(read.pastMembers.map((m: R) => m.name)).toEqual(["Ann"]);
    expect((await run({ action: "team_delete", team: "Sync" })).deleted).toBe(true);
    expect(listTeams(db, "ws")).toEqual([]);
  });

  it("lists every team and who has none", async () => {
    person("Ann", "Design");
    person("Bo");
    const out = await run({ action: "teams" });
    expect(out.teams.map((t: R) => t.name)).toEqual(["Design"]);
    expect(out.withoutTeam).toBe(1);
  });

  it("an inferred write fills gaps but never replaces what the user set", async () => {
    const t = createTeam(db, { workspaceId: "ws", name: "Sync", description: "Mine" });
    await run({ action: "team_upsert", team: "Sync", provenance: "inferred", teamInfo: { description: "Guess", channel: "#sync" } });
    expect(getTeam(db, t.id)).toMatchObject({ description: "Mine", channel: "#sync" });
  });

  it("archive, merge and an ended edge through the tool", async () => {
    const a = person("Ann");
    const b = person("Annie");
    const boss = person("Boss");
    expect((await run({ action: "archive", personId: b.id })).archived).toBe(true);
    expect((await run({ action: "archive", personId: b.id, remove: true })).restored).toBe(true);
    const merged = await run({ action: "merge", personId: a.id, otherPersonId: b.id });
    expect(merged.merged).toBe(true);
    const linked = await run({ action: "link", link: "edge", personId: boss.id, edgeType: "manager_of", otherPersonId: a.id, endedAt: "2026-05-01" });
    expect(linked.edge.ended).toBeTruthy();
  });
});
