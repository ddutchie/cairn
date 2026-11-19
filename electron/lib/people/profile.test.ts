import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { makeDb, seedWorkspace } from "../../test-support/db";
import { createPerson } from "../../db/people-queries";
import { PROFILE_TTL_MS } from "../../../shared/people/oneonone";
import { clearProfile, getCachedProfile, pickLookupTool, refreshProfile, resetProfileThrottle, type ProfileDeps } from "./profile";

let db: Database.Database;
beforeEach(() => { db = makeDb(); seedWorkspace(db); resetProfileThrottle(); });
afterEach(() => db.close());

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-18T12:00:00Z");
const slackReply = JSON.stringify({ user: { tz: "Europe/London", profile: { title: "Staff Engineer", pronouns: "she/her" } } });
const defs = [
  { function: { name: "mcp__slack__post_message", parameters: { properties: { channel: {}, text: {} } } } },
  { function: { name: "mcp__slack__get_user_profile", parameters: { properties: { user_id: {} }, required: ["user_id"] } } },
  { function: { name: "mcp__github__get_user", parameters: { properties: { user: {} } } } },
];
function deps(over: Partial<ProfileDeps> & { clock?: { t: number } } = {}) {
  const clock = over.clock ?? { t: T0 };
  const call = vi.fn(async () => slackReply);
  return { clock, call, d: { now: () => clock.t, slackServers: () => ["slack"], defs: async () => defs, call, ...over } as ProfileDeps };
}
const ana = () => createPerson(db, { workspaceId: "ws1", name: "Ana Ruiz", slackId: "U123" });

describe("pickLookupTool", () => {
  it("picks the Slack read tool that takes a user id, never a writer or another server's tool", () => {
    expect(pickLookupTool(defs, "slack")).toEqual({ name: "mcp__slack__get_user_profile", idArg: "user_id" });
    expect(pickLookupTool(defs, "github")).toEqual({ name: "mcp__github__get_user", idArg: "user" });
    expect(pickLookupTool(defs, "teams")).toBeNull();
  });
  it("needs an id argument it recognises", () => {
    expect(pickLookupTool([{ function: { name: "mcp__slack__get_user_profile", parameters: { properties: { foo: {} } } } }], "slack")).toBeNull();
  });
  it("prefers a profile tool over a looser name", () => {
    const loose = { function: { name: "mcp__slack__get_user", parameters: { properties: { user: {} } } } };
    expect(pickLookupTool([loose, defs[1]], "slack")?.name).toBe("mcp__slack__get_user_profile");
  });
});

describe("refreshProfile", () => {
  it("reads through the connector with the Slack id and caches the fields", async () => {
    const p = ana();
    const { d, call } = deps();
    const out = await refreshProfile(db, p.id, d);
    expect(call).toHaveBeenCalledWith(db, "ws1", [], "mcp__slack__get_user_profile", { user_id: "U123" });
    expect(out).toMatchObject({ fields: { title: "Staff Engineer", timezone: "Europe/London", pronouns: "she/her" }, stale: false });
    expect(getCachedProfile(db, p.id, T0).fields.title).toBe("Staff Engineer");
  });

  it("shows the cache first and doesn't call again within 24 hours", async () => {
    const p = ana();
    const { d, call, clock } = deps();
    await refreshProfile(db, p.id, d);
    clock.t = T0 + 23 * HOUR;
    await refreshProfile(db, p.id, d);
    expect(call).toHaveBeenCalledTimes(1);
    clock.t = T0 + 25 * HOUR;
    const old = getCachedProfile(db, p.id, clock.t);
    expect(old.stale).toBe(true); // the page renders it, marked, while the refresh runs
    await refreshProfile(db, p.id, d);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good fields, marked stale, when a refresh fails", async () => {
    const p = ana();
    const { d, clock } = deps();
    await refreshProfile(db, p.id, d);
    clock.t = T0 + PROFILE_TTL_MS + HOUR;
    const out = await refreshProfile(db, p.id, { ...d, call: async () => "Error: not_authed" });
    expect(out.fields.title).toBe("Staff Engineer");
    expect(out.stale).toBe(true);
    expect(out.error).toContain("not_authed");
    expect(out.fetchedAt).toBe(new Date(T0).toISOString());
  });

  it("doesn't retry a failure for ten minutes", async () => {
    const p = ana();
    const call = vi.fn(async () => { throw new Error("boom"); });
    const { d, clock } = deps({ call });
    await refreshProfile(db, p.id, d);
    clock.t = T0 + 5 * 60_000;
    await refreshProfile(db, p.id, d);
    expect(call).toHaveBeenCalledTimes(1);
    clock.t = T0 + 11 * 60_000;
    await refreshProfile(db, p.id, d);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("is a no-op with no Slack connector, no Slack id or an unreadable reply", async () => {
    const p = ana();
    const none = deps({ slackServers: () => [] });
    expect(await refreshProfile(db, p.id, none.d)).toEqual({ fields: {}, stale: false });
    expect(none.call).not.toHaveBeenCalled();
    const noId = createPerson(db, { workspaceId: "ws1", name: "No Slack" });
    const d2 = deps();
    expect(await refreshProfile(db, noId.id, d2.d)).toEqual({ fields: {}, stale: false });
    expect(d2.call).not.toHaveBeenCalled();
    const bad = deps({ call: async () => "Ana is a Staff Engineer" });
    const out = await refreshProfile(db, p.id, bad.d);
    expect(out.fields).toEqual({});
    expect(out.error).toBeTruthy();
  });

  it("shares one fetch between concurrent opens of the page", async () => {
    const p = ana();
    const { d, call } = deps();
    await Promise.all([refreshProfile(db, p.id, d), refreshProfile(db, p.id, d)]);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("forgets the fields on clear, and never writes them to the person", async () => {
    const p = ana();
    await refreshProfile(db, p.id, deps().d);
    expect(JSON.stringify(db.prepare("SELECT * FROM people").all())).not.toContain("Staff Engineer");
    clearProfile(db, p.id);
    expect(getCachedProfile(db, p.id)).toEqual({ fields: {}, stale: false });
  });
});
