/** Which calls wait on the confirmation card, and what it says. */
import { describe, it, expect } from "vitest";
import { confirmRequestFor } from "./confirm-gate";

const lookup = {
  noteTitle: (id: string) => (id === "n1" ? "Plan" : undefined),
  taskTitle: (id: string) => (id === "c1" ? "" : undefined),
  personName: (id: string) => ({ p1: "Ana Ruiz", p2: "Ana R" } as Record<string, string>)[id],
};

describe("confirmRequestFor", () => {
  it("words deletes by title, and skips the card when the item is missing", () => {
    expect(confirmRequestFor("delete", { type: "note", id: "n1" }, lookup)).toMatchObject({ title: "Delete the note “Plan”?", confirmLabel: "Delete note" });
    expect(confirmRequestFor("delete", { type: "task", id: "c1" }, lookup)?.title).toBe("Delete the task “Untitled”?");
    expect(confirmRequestFor("delete", { type: "note", id: "gone" }, lookup)).toBeUndefined();
  });

  it("asks before People archives, merges and team deletes", () => {
    expect(confirmRequestFor("people", { action: "archive", personId: "p1" }, lookup)?.title).toBe("Archive Ana Ruiz?");
    expect(confirmRequestFor("people", { action: "merge", personId: "p1", otherPersonId: "p2" }, lookup)?.title).toBe("Merge Ana R into Ana Ruiz?");
    expect(confirmRequestFor("people", { action: "team_delete", team: "Design" }, lookup)?.confirmLabel).toBe("Delete team");
  });

  it("runs reads, other writes and restores without a card", () => {
    expect(confirmRequestFor("people", { action: "archive", personId: "p1", remove: true }, lookup)).toBeUndefined();
    expect(confirmRequestFor("people", { action: "upsert", name: "Ana" }, lookup)).toBeUndefined();
    expect(confirmRequestFor("edit_note", { noteId: "n1" }, lookup)).toBeUndefined();
    expect(confirmRequestFor("mcp__github__create_issue", {}, lookup)).toBeUndefined();
  });
});
