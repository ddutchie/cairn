import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../events";
import { forkRecords, forkSessionLog } from "./fork";
import { openSession, readSession } from "./log";

const root = () => mkdtempSync(path.join(os.tmpdir(), "fork-"));
const events: AgentEvent[] = [
  { type: "user/message", content: "plan the release" },
  { type: "rule/added", rule: { id: "r1", effect: "allow", scope: "session", source: "user", match: { tool: "bash" } } } as AgentEvent,
  { type: "goal/changed", operation: "create", goal: null },
  { type: "session/title", title: "Release plan" },
];

async function seed(dir: string, id: string) {
  const { writer } = await openSession(dir, { id, cwd: "/code" });
  for (const event of events) await writer.append(event);
}

describe("fork", () => {
  it("leaves the goal and reminders behind, and rules unless asked to keep them", () => {
    const records = events.map((event, i) => ({ seq: i + 1, time: i, event }));
    expect(forkRecords(records, { keepRules: false }).map((r) => r.event.type)).toEqual(["user/message", "session/title"]);
    expect(forkRecords(records, { keepRules: true }).map((r) => r.event.type)).toEqual(["user/message", "rule/added", "session/title"]);
  });

  it("writes a top-level session that records where it came from", async () => {
    const dir = root();
    await seed(dir, "chat-a");
    expect(await forkSessionLog(dir, { from: "chat-a", to: "b", cwd: "/repo", keepRules: false })).toBe(2);
    const fork = (await readSession(dir, "b"))!;
    expect(fork.header).toMatchObject({ id: "b", cwd: "/repo", forkedFrom: "chat-a" });
    // `parentId` would make the host treat the fork as a subagent.
    expect(fork.header.parentId).toBeUndefined();
    expect((await readSession(dir, "chat-a"))!.records).toHaveLength(4);
    // The fork continues its own sequence.
    const { writer } = await openSession(dir, { id: "b" });
    expect((await writer.append({ type: "user/message", content: "next" }))!.seq).toBe(5);
  });

  it("keeps the source's folder by default, and refuses an empty source or an existing target", async () => {
    const dir = root();
    await seed(dir, "a");
    await forkSessionLog(dir, { from: "a", to: "b", keepRules: true });
    expect((await readSession(dir, "b"))!.header.cwd).toBe("/code");
    await expect(forkSessionLog(dir, { from: "a", to: "b", keepRules: true })).rejects.toThrow(/already exists/);
    await expect(forkSessionLog(dir, { from: "missing", to: "c", keepRules: true })).rejects.toThrow(/nothing to fork/);
  });
});
