import { describe, it, expect } from "vitest";
import { toolRef, idFrom, NOTE_TOOLS, CARD_TOOLS } from "./tool-ref";

describe("idFrom", () => {
  it("extracts a non-empty string id", () => {
    expect(idFrom({ id: "abc" })).toBe("abc");
  });
  it("returns null for a missing id", () => {
    expect(idFrom({ foo: "bar" })).toBeNull();
  });
  it("returns null for an empty-string id", () => {
    expect(idFrom({ id: "" })).toBeNull();
  });
  it("returns null for a non-string id", () => {
    expect(idFrom({ id: 42 })).toBeNull();
  });
  it("returns null for non-objects", () => {
    expect(idFrom(null)).toBeNull();
    expect(idFrom(undefined)).toBeNull();
    expect(idFrom("x")).toBeNull();
  });
});

describe("toolRef", () => {
  it("reads a note id from the RESULT for result-sourced note tools", () => {
    expect(toolRef("ensure_note", {}, { id: "n1" })).toEqual({ kind: "note", id: "n1" });
    expect(toolRef("create_note", {}, { id: "n2" })).toEqual({ kind: "note", id: "n2" });
  });

  it("reads a note id from the ARGS for args-sourced note tools", () => {
    expect(toolRef("get_note", { id: "n3" }, {})).toEqual({ kind: "note", id: "n3" });
    expect(toolRef("patch_note", { id: "n4" }, { ok: true })).toEqual({ kind: "note", id: "n4" });
    expect(toolRef("rename_note", { id: "n5" }, {})).toEqual({ kind: "note", id: "n5" });
    expect(toolRef("move_note_to_project", { id: "n6" }, {})).toEqual({ kind: "note", id: "n6" });
  });

  it("reads a card id from result/args per the CARD_TOOLS table", () => {
    expect(toolRef("create_task", {}, { id: "c1" })).toEqual({ kind: "card", id: "c1" });
    expect(toolRef("get_task", { id: "c2" }, {})).toEqual({ kind: "card", id: "c2" });
    expect(toolRef("update_task", { id: "c3" }, {})).toEqual({ kind: "card", id: "c3" });
  });

  it("returns undefined for an unknown / read-only tool", () => {
    expect(toolRef("search_notes", { query: "x" }, [{ id: "n1" }])).toBeUndefined();
    expect(toolRef("get_cairn_context", {}, {})).toBeUndefined();
  });

  it("never navigates to an errored tool result", () => {
    expect(toolRef("ensure_note", {}, { error: "boom" })).toBeUndefined();
    expect(toolRef("get_note", { id: "n1" }, { error: "not found" })).toBeUndefined();
  });

  it("returns undefined when the expected id is absent", () => {
    expect(toolRef("ensure_note", {}, {})).toBeUndefined();
    expect(toolRef("get_note", {}, {})).toBeUndefined();
  });

  it("sources every table entry from the declared location", () => {
    // Guards against a future edit flipping an args/result mapping silently.
    for (const [tool, where] of Object.entries(NOTE_TOOLS)) {
      const withId = { id: "x" };
      const ref = toolRef(tool, where === "args" ? withId : {}, where === "result" ? withId : {});
      expect(ref).toEqual({ kind: "note", id: "x" });
    }
    for (const [tool, where] of Object.entries(CARD_TOOLS)) {
      const withId = { id: "y" };
      const ref = toolRef(tool, where === "args" ? withId : {}, where === "result" ? withId : {});
      expect(ref).toEqual({ kind: "card", id: "y" });
    }
  });
});
