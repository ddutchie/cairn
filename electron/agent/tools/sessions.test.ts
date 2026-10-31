import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openSession } from "../session/log";
import { sessionTools, turnsOf } from "./sessions";

const ctx = { signal: undefined } as never;

async function seed(root: string, id: string, turns: Array<[string, string]>, parentId?: string) {
  const { writer } = await openSession(root, { id, cwd: "/w", parentId });
  await writer.append({ type: "user/message", content: turns[0][0] });
  for (const [, reply] of turns) {
    await writer.append({ type: "assistant/message", message: { role: "assistant", content: [{ type: "text", text: reply }] } as never });
  }
}

describe("session search tools", () => {
  it("finds workspace sessions by all words, hides other workspaces, the current session and subagent children", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sess-"));
    try {
      await seed(root, "chat-a", [["What export format do we use?", "We decided on CSV export for the report."]]);
      await seed(root, "chat-other", [["export format?", "CSV in another workspace."]]);
      await seed(root, "chat-now", [["export format", "current"]]);
      await seed(root, "child-1", [["export format", "CSV child"]], "chat-a");
      const [search, read] = sessionTools({ root, currentSession: "chat-now", workspaceSessionIds: () => new Set(["chat-a", "chat-now", "child-1"]) });
      const out = await search.execute({ query: "csv export" }, ctx);
      expect(out.content).toContain("chat-a");
      expect(out.content).not.toContain("chat-other");
      expect(out.content).not.toContain("chat-now");
      expect(out.content).not.toContain("child-1");
      expect((await search.execute({ query: "kubernetes" }, ctx)).content).toMatch(/No earlier session/);

      const full = await read.execute({ id: "chat-a" }, ctx);
      expect(full.content).toContain("What export format do we use?");
      expect(full.content).toContain("CSV export");
      expect((await read.execute({ id: "chat-other" }, ctx)).isError).toBe(true);
      expect((await read.execute({ id: "../etc" }, ctx)).isError).toBe(true);
      expect((await read.execute({ id: "chat-now" }, ctx)).isError).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("turnsOf keeps only user and assistant text", () => {
    expect(turnsOf([
      { seq: 0, time: 1, event: { type: "user/message", content: "hi" } },
      { seq: 1, time: 2, event: { type: "tool/result", callId: "c", name: "x", text: "noise", isError: false } },
    ])).toEqual([{ index: 0, role: "user", text: "hi", time: 1 }]);
  });
});
