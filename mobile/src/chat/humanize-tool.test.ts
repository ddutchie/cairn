import { describe, expect, it } from "vitest";
import { humanizeToolCall, type HumanizeLookup } from "./humanize-tool";

const lookup: HumanizeLookup = {
  noteTitle: (id) => (id === "n1" ? "Cairn Roadmap (Canonical)" : undefined),
  taskTitle: (id) => (id === "c1" ? "Ship it" : undefined),
  projectName: (id) => (id === "p1" ? "Cairn" : undefined),
};

describe("humanizeToolCall", () => {
  it("labels reads as reads — never as edits", () => {
    expect(humanizeToolCall("get_item", { id: "n1" }, { kind: "note", id: "n1" }, lookup))
      .toBe("Read note Cairn Roadmap (Canonical)");
    expect(humanizeToolCall("get_item", { id: "c1" }, { kind: "card", id: "c1" }, lookup))
      .toBe("Read task Ship it");
    // Running chip (no ref yet): resolves through args + lookup.
    expect(humanizeToolCall("get_item", { id: "n1" }, undefined, lookup))
      .toBe("Read note Cairn Roadmap (Canonical)");
  });

  it("falls back to the id when the item is gone", () => {
    expect(humanizeToolCall("get_item", { id: "gone" }, { kind: "note", id: "gone" }, lookup))
      .toBe("Read note gone");
  });

  it("names context, searches and writes like the desktop transcript", () => {
    expect(humanizeToolCall("get_context", { projectId: "p1" }, undefined, lookup))
      .toBe("Read project context for Cairn");
    expect(humanizeToolCall("get_context", {}, undefined, lookup)).toBe("Read workspace context");
    expect(humanizeToolCall("search_notes", { query: "auth" }, undefined, lookup))
      .toBe("Searched notes for \u201cauth\u201d");
    expect(humanizeToolCall("search_tasks", { query: "", filter: "overdue" }, undefined, lookup))
      .toBe("Listed overdue tasks");
    expect(humanizeToolCall("ensure_note", { title: "T" }, undefined, lookup)).toBe("Saved note T");
    expect(humanizeToolCall("update_notes", { noteIds: ["n1"], folder: "f" }, undefined, lookup))
      .toBe("Moved Cairn Roadmap (Canonical) to f");
    expect(humanizeToolCall("update_tasks", { cardIds: ["c1"], columnType: "done" }, undefined, lookup))
      .toBe("Moved Ship it to done");
    expect(humanizeToolCall("delete", { type: "note", id: "gone" }, undefined, lookup))
      .toBe("Deleted note gone");
  });

  it("keeps the prettified raw name for unknown and connector tools", () => {
    expect(humanizeToolCall("mcp__srv__read_file", {}, undefined, lookup)).toBe("Read file");
    expect(humanizeToolCall("mystery_tool", {}, undefined, lookup)).toBe("Mystery tool");
  });
});
