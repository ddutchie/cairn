import { describe, expect, it } from "vitest";
import { snapshotJsonValue } from "@deepseek-ai/dsh-util-values";
import { toCard } from "../host-shared/db-mappers";
import { toLosslessJson } from "./cairn-tools";

describe("toLosslessJson", () => {
  // A fresh task row: no description/due date, not archived or completed.
  const row = {
    id: "c1", column_id: "col", project_id: "p", workspace_id: "w", title: "Task",
    description: null, tag_ids: "[]", priority: "medium", due_date: null,
    linked_note_ids: "[]", blocked_by_ids: "[]", order: 0, assignee: null,
    created_at: "2026-10-08T00:00:00Z", updated_at: "2026-10-08T00:00:00Z",
    archived_at: null, completed_at: null, version: 1,
  };

  it("makes a card dsh rejects (undefined props) acceptable", () => {
    const card = toCard(row);
    // The bug: dsh treats this as a failed tool call even though the write landed.
    expect(snapshotJsonValue(card)).toBeUndefined();
    expect(snapshotJsonValue(toLosslessJson(card))).toEqual(toLosslessJson(card));
    expect(toLosslessJson({ ...card, movedTo: null })).toMatchObject({ id: "c1", title: "Task", movedTo: null });
  });

  it("maps undefined to null and passes strings through", () => {
    expect(toLosslessJson(undefined)).toBeNull();
    expect(toLosslessJson("plain text")).toBe("plain text");
  });
});
