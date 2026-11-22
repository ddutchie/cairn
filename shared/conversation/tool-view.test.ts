import { describe, expect, it } from "vitest";
import { cairnToolView, changesOf, diffBlock, parseToolResult, searchResultCount, type ToolCallInput } from "./tool-view";

const call = (name: string, args: Record<string, unknown>, output?: unknown, ok = true): ToolCallInput => ({
  name, args, ok, output: output === undefined ? undefined : typeof output === "string" ? output : JSON.stringify(output),
});

describe("parseToolResult", () => {
  it("wraps a top-level array and rejects non-JSON", () => {
    expect(parseToolResult("[1,2]")).toEqual({ results: [1, 2] });
    expect(parseToolResult("nope")).toBeUndefined();
    expect(parseToolResult(undefined)).toBeUndefined();
  });
  it("counts search hits", () => {
    expect(searchResultCount("[1,2,3]")).toBe(3);
    expect(searchResultCount('{"results":[1]}')).toBe(1);
    expect(searchResultCount('{"a":1}')).toBeUndefined();
  });
});

describe("changesOf", () => {
  it("keeps only well-formed entries and defaults the title", () => {
    expect(changesOf({ changes: [{ id: "a", field: "due", to: "2026-01-02" }, { id: "b" }, "x"] })).toEqual([
      { id: "a", title: "Untitled", field: "due", from: undefined, to: "2026-01-02" },
    ]);
  });
});

describe("diffBlock", () => {
  it("cuts long diffs but keeps a line of each side", () => {
    const removed = Array.from({ length: 30 }, (_, i) => `old ${i}`).join("\n");
    const d = diffBlock(removed, "new");
    expect(d.rows.filter((r) => r.sign === "+")).toHaveLength(1);
    expect(d.rows).toHaveLength(10);
    expect(d.hidden).toBe(21);
  });
  it("shows everything when short", () => {
    expect(diffBlock("a", "b")).toEqual({ type: "diff", rows: [{ sign: "-", text: "a" }, { sign: "+", text: "b" }], hidden: 0 });
  });
});

describe("cairnToolView", () => {
  it("groups recorded task changes by card", () => {
    const panels = cairnToolView(call("update_tasks", { cardIds: ["1"] }, {
      id: "1", updated: true,
      changes: [{ id: "1", title: "Ship", field: "column", from: "Todo", to: "Done" }, { id: "1", title: "Ship", field: "priority", from: "low", to: "high" }],
    }));
    expect(panels?.[0].label).toBe("Changes");
    expect(panels?.[0].blocks[0]).toEqual({
      type: "groups",
      groups: [{ title: "Ship", rows: [{ field: "column", from: "Todo", to: "Done" }, { field: "priority", from: "low", to: "high" }] }],
    });
  });
  it("says nothing changed for an empty measured list", () => {
    const panels = cairnToolView(call("update_tasks", { cardIds: ["1"] }, { id: "1", changes: [] }));
    expect(panels?.[0].blocks[0]).toMatchObject({ type: "text", text: "No changes: everything was already set." });
  });
  it("falls back to the requested fields before it has run", () => {
    const panels = cairnToolView({ name: "update_tasks", args: { cardIds: ["1"], priority: "high", columnType: "in_progress" }, ok: true }, { pending: true });
    expect(panels?.[0]).toMatchObject({ label: "Requested", blocks: [{ type: "rows", rows: [{ field: "priority", to: "high" }, { field: "column", to: "in progress" }] }] });
  });
  it("shows an edit as a diff and an append as added only", () => {
    expect(cairnToolView(call("edit_note", { noteId: "n", oldString: "a", newString: "b" }))?.[0]).toMatchObject({ label: "Edit" });
    expect(cairnToolView(call("edit_note", { noteId: "n", newString: "b" }))?.[0]).toMatchObject({ label: "Appended" });
    expect(cairnToolView(call("edit_note", { noteId: "n", newString: "" }))).toBeNull();
  });
  it("lists search hits with a count and a tail", () => {
    const results = Array.from({ length: 7 }, (_, i) => ({ title: `T${i}`, folder: "F" }));
    const panels = cairnToolView(call("search_notes", { query: "x" }, results));
    expect(panels?.[0].label).toBe("7 results for “x”");
    expect(panels?.[0].blocks[0]).toMatchObject({ type: "hits", more: 2 });
    expect(cairnToolView(call("search_tasks", { query: "x" }, []))?.[0].blocks[0]).toMatchObject({ text: "No results for “x”." });
  });
  it("words a delete in future tense while pending and as danger", () => {
    const panels = cairnToolView({ name: "delete", args: { type: "task", id: "c1" }, ok: true }, { pending: true });
    expect(panels?.[0]).toMatchObject({ label: "Will delete", tone: "danger" });
  });
  it("summarises idea-flow ops", () => {
    const panels = cairnToolView(call("edit_idea_flow", { ops: [{ op: "add_node", data: { label: "A" } }, { op: "add_node", data: { label: "B" } }, { op: "delete_edge" }] }));
    expect(panels?.[0].blocks[0]).toMatchObject({ text: "2 nodes added · 1 connection removed" });
    expect(panels?.[0].blocks[1]).toEqual({ type: "chips", items: ["A", "B"] });
  });
  it("hides a failed call unless it reports what applied", () => {
    expect(cairnToolView(call("update_tasks", { cardIds: ["1"] }, { error: "boom" }, false))).toBeNull();
    expect(cairnToolView(call("update_tasks", { cardIds: ["1"] }, { error: "x", changes: [{ id: "1", title: "A", field: "due", to: "d" }] }, false))).not.toBeNull();
  });
  it("masks secrets in the requested arguments", () => {
    const panels = cairnToolView({ name: "create_task", args: { title: "rotate password=hunter2secret now" }, ok: true });
    expect(JSON.stringify(panels)).not.toContain("hunter2secret");
  });
  it("returns null for tools without a view", () => {
    expect(cairnToolView(call("get_context", {}, { a: 1 }))).toBeNull();
  });
  it("renders a people upsert", () => {
    const panels = cairnToolView(call("people", { action: "upsert", name: "Ada", cadence: "weekly" }, { created: true, person: { name: "Ada" } }));
    expect(panels?.[0].label).toBe("Added to People");
  });
});
