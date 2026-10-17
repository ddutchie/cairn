import { describe, expect, it } from "vitest";
import { buildCapturePrompt, FILE_CAPTURE_TOOL, MAX_CAPTURE_CHARS } from "./prompt";
import type { CaptureContext } from "./types";

const ctx: CaptureContext = {
  projects: [{ id: "p1", name: "Kitchen", columns: [{ id: "c1", name: "Backlog", type: "backlog" }] }],
  tags: Array.from({ length: 100 }, (_, i) => `tag${i}`),
  candidates: Array.from({ length: 10 }, (_, i) => ({ noteId: `n${i}`, title: `Note ${i}`, projectId: "p1", rank: 1 - i / 10 })),
  projectScores: [],
  recentProjectId: "p1",
  today: "2026-10-17",
};

describe("buildCapturePrompt", () => {
  it("includes ids, today's date, and the captured text", () => {
    const p = buildCapturePrompt("buy tiles tomorrow", ctx);
    expect(p).toContain('"id":"p1"');
    expect(p).toContain("2026-10-17");
    expect(p).toContain("buy tiles tomorrow");
  });

  it("caps tags, candidates and text so the prompt stays small", () => {
    const p = buildCapturePrompt("x".repeat(MAX_CAPTURE_CHARS * 3), ctx);
    expect(p).not.toContain("tag40");
    expect(p).toContain("tag39");
    expect(p).not.toContain('"id":"n6"');
    expect(p).toContain('"id":"n5"');
    expect(p.length).toBeLessThan(MAX_CAPTURE_CHARS + 3000);
  });

  it("does not leak column ids", () => {
    expect(buildCapturePrompt("x", ctx)).not.toContain("c1");
  });
});

describe("FILE_CAPTURE_TOOL", () => {
  it("requires only projectId and is a valid object schema", () => {
    expect(FILE_CAPTURE_TOOL.jsonSchema.type).toBe("object");
    expect(FILE_CAPTURE_TOOL.jsonSchema.required).toEqual(["projectId"]);
  });
});
