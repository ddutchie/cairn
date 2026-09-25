import { describe, it, expect } from "vitest";
import { resolvePromptContext } from "./context-resolver";
import type { Note } from "@/types";

const note = { id: "n1", title: "Spec", type: "note", folder: "", archivedAt: undefined } as unknown as Note;

describe("resolvePromptContext with lazily-loaded bodies", () => {
  it("loads a missing body on demand", async () => {
    const out = await resolvePromptContext("see [[Spec]]", [note], [], [], null, async () => "the body");
    expect(out).toContain("the body");
  });

  it("reports a failed load instead of claiming the note is empty", async () => {
    const out = await resolvePromptContext("see [[Spec]]", [note], [], [], null, async () => undefined);
    expect(out).toContain("(content could not be loaded)");
    expect(out).not.toContain("(empty)");
  });
});
