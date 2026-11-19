/** `@Name` in a chat message → the context block the model gets (shared/people/mentions.ts), on a real schema. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "./schema";
import { createWorkspace } from "./queries";
import { agentHiddenNoteIds, createPerson } from "./people-queries";
import { personMentionContext } from "../../shared/people/mentions";

let db: Database.Database;
const ctx = {};
const ctxFor = (text: string) => personMentionContext(db, ctx, "ws", text, agentHiddenNoteIds(db));

beforeEach(() => {
  db = new BetterSqlite3(":memory:");
  applySchema(db);
  createWorkspace(db, { id: "ws", name: "WS" });
});
afterEach(() => db.close());

describe("personMentionContext", () => {
  it("attaches the mentioned person", () => {
    createPerson(db, { workspaceId: "ws", name: "Ana Lopez", relationship: [{ type: "direct_report", provenance: "explicit" }] });
    const out = ctxFor("prep my 1:1 with @Ana Lopez");
    expect(out).toContain("Ana Lopez");
    expect(out).toContain("direct_report");
  });
  it("says nothing without a mention, for an unknown name, ", () => {
    createPerson(db, { workspaceId: "ws", name: "Ana Lopez" });
    expect(ctxFor("no mention here")).toBeUndefined();
    expect(ctxFor("hello @Zed")).toBeUndefined();
  });
  it("asks which person when a name is shared", () => {
    createPerson(db, { workspaceId: "ws", name: "Chris" });
    createPerson(db, { workspaceId: "ws", name: "Chris" });
    expect(ctxFor("@Chris said")).toMatch(/more than one person/);
  });
  it("leaves out a private persona note id", () => {
    db.prepare("INSERT INTO projects (id, workspace_id, name, created_at, updated_at) VALUES ('x','ws','X','','')").run();
    db.prepare("INSERT INTO notes (id, project_id, workspace_id, title, content, created_at, updated_at) VALUES ('n', 'x', 'ws', 'Ana', '', '', '')").run();
    const p = createPerson(db, { workspaceId: "ws", name: "Ana Lopez", personaNoteId: "n", agentPrivate: true });
    const out = ctxFor("@Ana Lopez");
    expect(out).toContain(p.id);
    expect(out).not.toMatch(/"personaNoteId":"n"/);
  });
});
