/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { makeDb, seedWorkspace, seedProject } from "../../test-support/db";
import { applySchema } from "../../db/schema";
import { getProjectById } from "../../db/queries";
import { getSnapshot } from "../db";
import { upsert_project } from "./projects";
import { executeGetProjectContextPack } from "../../host-shared/read-tools-pure";

let db: Database.Database;
beforeEach(() => { db = makeDb(); seedWorkspace(db); seedProject(db); });
afterEach(() => db.close());

const call = (args: Record<string, unknown>) => upsert_project(db, getSnapshot(db), "/tmp/ws", args) as any;

describe("project links through upsert_project and get_context", () => {
  it("adds, updates in place, and removes links", () => {
    call({ projectId: "proj1", addLinks: [
      { url: "https://acme.atlassian.net/wiki/spaces/ENG/overview" },
      { url: "https://acme.slack.com/archives/C1", label: "#proj-alerts", note: "on-call" },
    ] });
    let links = getProjectById(db, "proj1")!.links!;
    expect(links.map((l) => [l.kind, l.ref])).toEqual([["confluence", "ENG"], ["slack", "C1"]]);

    call({ projectId: "proj1", addLinks: [{ url: "https://acme.slack.com/archives/C1", label: "#alerts" }] });
    links = getProjectById(db, "proj1")!.links!;
    expect(links).toHaveLength(2);
    expect(links[1]).toMatchObject({ label: "#alerts", note: "on-call" });

    call({ projectId: "proj1", removeLinkIds: [links[0].id] });
    expect(getProjectById(db, "proj1")!.links!.map((l) => l.kind)).toEqual(["slack"]);
  });

  it("leaves links alone when the call names none", () => {
    call({ projectId: "proj1", addLinks: [{ url: "https://github.com/acme/widgets" }] });
    call({ projectId: "proj1", description: "hello" });
    expect(getProjectById(db, "proj1")!.links).toHaveLength(1);
  });

  it("reports URLs it refused", () => {
    const r = call({ projectId: "proj1", addLinks: [{ url: "javascript:1" }] });
    expect(r.rejectedLinks).toEqual(["javascript:1"]);
    expect(getProjectById(db, "proj1")!.links).toEqual([]);
  });

  it("accepts links on create", () => {
    const r = call({ workspaceId: "ws1", name: "New", addLinks: [{ url: "https://github.com/acme/new" }] });
    expect(r.project.links).toHaveLength(1);
  });

  it("get_context returns links with their ref, and omits the key when there are none", () => {
    const empty = executeGetProjectContextPack(getSnapshot(db), { projectId: "proj1" }) as any;
    expect(empty.project.links).toBeUndefined();
    call({ projectId: "proj1", addLinks: [{ url: "https://acme.atlassian.net/wiki/spaces/ENG" }] });
    const pack = executeGetProjectContextPack(getSnapshot(db), { projectId: "proj1" }) as any;
    expect(pack.project.links[0]).toMatchObject({ kind: "confluence", ref: "ENG" });
  });

  it("get_context lists addresses from the description that are not saved yet", () => {
    call({ projectId: "proj1", description: "Spec: https://acme.atlassian.net/wiki/spaces/ENG and https://github.com/acme/w." });
    call({ projectId: "proj1", addLinks: [{ url: "https://github.com/acme/w" }] });
    const pack = executeGetProjectContextPack(getSnapshot(db), { projectId: "proj1" }) as any;
    expect(pack.project.unsavedLinks).toEqual(["https://acme.atlassian.net/wiki/spaces/ENG"]);
  });

  it("adds the column to a database that predates it, and syncs it as part of the row", () => {
    const old = makeDbBefore();
    applySchema(old);
    const cols = (old.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("links");
    old.close();
  });
});

function makeDbBefore(): Database.Database {
  const d = makeDb();
  d.exec("ALTER TABLE projects DROP COLUMN links");
  return d;
}
