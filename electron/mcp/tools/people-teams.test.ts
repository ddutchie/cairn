/**
 * Teams (sync protocol 7): the shared queries (rename moves members, delete
 * takes the team off them, no cycles) and the `people` tool's `teams` /
 * `team_upsert` actions through the MCP executor.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type Database from "better-sqlite3";
import { makeDb } from "../../test-support/db";
import { createWorkspace } from "../../db/queries";
import { createPerson, getPerson } from "../../db/people-queries";
import { createTeam, deleteTeam, getTeam, listTeams, updateTeam } from "../../../shared/people/team-queries";
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
  it("renaming a team moves its members, ignoring case and spacing", () => {
    const ann = person("Ann", "sync  team");
    const bo = person("Bo", "Other");
    const t = createTeam(db, { workspaceId: "ws", name: "Sync team" });
    updateTeam(db, t.id, { name: "Replication" });
    expect(getPerson(db, ann.id)!.team).toBe("Replication");
    expect(getPerson(db, bo.id)!.team).toBe("Other");
  });

  it("refuses a duplicate name and a parent cycle", () => {
    const a = createTeam(db, { workspaceId: "ws", name: "Platform" });
    const b = createTeam(db, { workspaceId: "ws", name: "Sync", parentTeamId: a.id });
    expect(() => createTeam(db, { workspaceId: "ws", name: "platform" })).toThrow(/already a team/);
    expect(() => updateTeam(db, a.id, { parentTeamId: b.id })).toThrow(/under itself/);
  });

  it("delete takes the team off members and moves child teams up", () => {
    const ann = person("Ann", "Sync");
    const root = createTeam(db, { workspaceId: "ws", name: "Platform" });
    const mid = createTeam(db, { workspaceId: "ws", name: "Sync", parentTeamId: root.id });
    const leaf = createTeam(db, { workspaceId: "ws", name: "Mobile sync", parentTeamId: mid.id });
    deleteTeam(db, mid.id);
    expect(getPerson(db, ann.id)!.team).toBeUndefined();
    expect(getTeam(db, leaf.id)!.parentTeamId).toBe(root.id);
    expect(listTeams(db, "ws").map((t) => t.name)).toEqual(["Mobile sync", "Platform"]);
  });

  it("queues a sync put for a new team", () => {
    createTeam(db, { workspaceId: "ws", name: "Sync" });
    const pending = db.prepare("SELECT entity, op FROM sync_pending WHERE entity = 'teams'").all();
    expect(pending).toEqual([{ entity: "teams", op: "put" }]);
  });
});

describe("people tool: teams", () => {
  it("team_upsert creates a team with details and members, and teams reads it back", async () => {
    const ann = person("Ann Lee");
    person("Bo Chen");
    const out = await run({
      action: "team_upsert", team: "Sync",
      teamInfo: { description: "Owns replication", lead: "Ann Lee", parentTeam: "Platform", channel: "#sync", members: ["Bo Chen"], links: [{ url: "https://example.com/board" }] },
    });
    expect(out.created).toBe(true);
    expect(out.addedMembers.sort()).toEqual(["Ann Lee", "Bo Chen"]);
    const read = await run({ action: "teams", team: "sync" });
    expect(read).toMatchObject({
      name: "Sync", description: "Owns replication", channel: "#sync", parentTeam: "Platform",
      lead: { id: ann.id, name: "Ann Lee" }, links: [{ label: "example.com", url: "https://example.com/board" }],
    });
    expect(read.members.map((m: R) => m.name)).toEqual(["Ann Lee", "Bo Chen"]);
  });

  it("lists teams people name even without details", async () => {
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
});
