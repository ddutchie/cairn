import { describe, it, expect } from "vitest";
import { applyChangesetToArrays, type ChangeSet, type EntityArrays } from "./change-feed";

const empty = (): EntityArrays => ({ workspaces: [], projects: [], notes: [], columns: [], cards: [], tags: [] });
const cs = (patch: Partial<ChangeSet>): ChangeSet => ({
  feedId: "f", head: 1, reset: false, touched: [], externalTouched: [], upserts: {}, removed: {}, ...patch,
});

describe("applyChangesetToArrays", () => {
  it("returns the same arrays when nothing in them changed", () => {
    const cur = empty();
    const next = applyChangesetToArrays(cur, cs({ touched: ["idea_flow_nodes"] }));
    for (const k of Object.keys(cur) as Array<keyof EntityArrays>) expect(next[k]).toBe(cur[k]);
  });

  it("replaces, inserts and removes rows, re-sorting like the snapshot SQL", () => {
    const cur = empty();
    cur.notes = [
      { id: "a", updatedAt: "2026-01-03" },
      { id: "b", updatedAt: "2026-01-02" },
      { id: "c", updatedAt: "2026-01-01" },
    ] as unknown as EntityArrays["notes"];
    cur.tags = [{ id: "t1" }, { id: "t2" }] as unknown as EntityArrays["tags"];
    const next = applyChangesetToArrays(cur, cs({
      upserts: {
        notes: [{ id: "c", updatedAt: "2026-01-05" }, { id: "d", updatedAt: "2026-01-04" }],
        tags: [{ id: "t3" }, { id: "t1", name: "renamed" }],
      },
      removed: { notes: ["b"] },
    }));
    // notes: updated_at DESC
    expect(next.notes.map((n) => n.id)).toEqual(["c", "d", "a"]);
    // tags: no ORDER BY — existing positions kept, new rows appended
    expect(next.tags.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect((next.tags[0] as unknown as { name: string }).name).toBe("renamed");
    // untouched entity arrays keep identity
    expect(next.cards).toBe(cur.cards);
  });
});
