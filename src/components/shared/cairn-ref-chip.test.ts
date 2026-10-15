import { describe, expect, it } from "vitest";
import { cairnActionLabel, extractCairnRef } from "./cairn-ref-chip";

describe("cairnActionLabel", () => {
  it("labels reads as reads — never as edits (consolidated toolset)", () => {
    // Regression: get_item (a read) fell through to the "Updated note"
    // fallback and rendered "Updated note" for a note that was only read.
    expect(cairnActionLabel("get_item", "note")).toBe("Read note");
    expect(cairnActionLabel("get_item", "task")).toBe("Read task");
    expect(cairnActionLabel("get_note", "note")).toBe("Read note");
    expect(cairnActionLabel("get_task", "task")).toBe("Read task");
  });

  it("labels consolidated writes and deletes correctly", () => {
    expect(cairnActionLabel("edit_note", "note")).toBe("Updated note");
    expect(cairnActionLabel("update_notes", "note")).toBe("Updated note");
    expect(cairnActionLabel("update_tasks", "task")).toBe("Updated task");
    expect(cairnActionLabel("task_progress", "task")).toBe("Updated task");
    expect(cairnActionLabel("delete", "note")).toBe("Deleted note");
    expect(cairnActionLabel("delete", "task")).toBe("Deleted task");
    expect(cairnActionLabel("delete_note", "note")).toBe("Deleted note");
    expect(cairnActionLabel("delete_task", "task")).toBe("Deleted task");
  });

  it("keeps legacy per-operation labels for older transcripts", () => {
    expect(cairnActionLabel("rename_note", "note")).toBe("Renamed note");
    expect(cairnActionLabel("claim_task", "task")).toBe("Claimed task");
    expect(cairnActionLabel("patch_note", "note")).toBe("Patched note");
  });
});

describe("extractCairnRef", () => {
  it("derives a note ref from a get_item read result", () => {
    const output = JSON.stringify({ type: "note", id: "n1", title: "Cairn Roadmap (Canonical)" });
    expect(extractCairnRef("get_item", output)).toEqual({ type: "note", id: "n1", title: "Cairn Roadmap (Canonical)" });
  });

  it("derives a task ref from a get_item read result", () => {
    const output = JSON.stringify({ type: "task", id: "c1", title: "Ship it" });
    expect(extractCairnRef("get_item", output)).toEqual({ type: "task", id: "c1", title: "Ship it" });
  });

  it("returns undefined for tools with no navigable ref", () => {
    expect(extractCairnRef("get_context", JSON.stringify({ workspace: {} }))).toBeUndefined();
    expect(extractCairnRef("search_notes", JSON.stringify([{ id: "n1" }]))).toBeUndefined();
  });
});
