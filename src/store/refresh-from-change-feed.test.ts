/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * refreshFromChangeFeed (store/index.ts): a db:changed event merges only the
 * changed rows, skips this window's own writes, clears undo only for external
 * changes, and falls back to a full snapshot when the feed asks for a reset.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useCairnStore } from "./index";
import { setChangeFeedCursor, getChangeFeedCursor, type ChangeSet } from "./change-feed";
import { historyManager } from "@/lib/history";

const note = (id: string, title: string, updatedAt = "2026-01-01") =>
  ({ id, projectId: "p1", workspaceId: "ws1", title, content: title, contentText: title, tagIds: [], linkedNoteIds: [], linkedCardIds: [], isPinned: false, type: "note", folder: "", createdAt: "2026-01-01", updatedAt }) as any;

const changeset = (patch: Partial<ChangeSet>): ChangeSet => ({
  feedId: "feed-1", head: 10, reset: false, touched: [], externalTouched: [], upserts: {}, removed: {}, ...patch,
});

describe("refreshFromChangeFeed", () => {
  const get = vi.fn();
  const snapshot = vi.fn();

  beforeEach(() => {
    get.mockReset();
    snapshot.mockReset();
    (globalThis as any).window = { electron: { changes: { get }, snapshot } };
    useCairnStore.setState({
      workspaces: [{ id: "ws1", name: "WS", createdAt: "2026-01-01", updatedAt: "2026-01-01" } as any],
      projects: [], columns: [], cards: [], tags: [],
      notes: [note("n1", "old"), note("n2", "keep")],
      activeWorkspaceId: "ws1",
      graphLoaded: false,
    });
    setChangeFeedCursor("feed-1", 5);
  });

  afterEach(() => {
    delete (globalThis as any).window;
  });

  it("merges an external changeset without reading the full snapshot", async () => {
    const clear = vi.spyOn(historyManager, "clear");
    const keep = useCairnStore.getState().notes[1];
    get.mockResolvedValueOnce(changeset({
      touched: ["notes"], externalTouched: ["notes"],
      upserts: { notes: [note("n1", "new", "2026-01-02")] },
    }));
    await useCairnStore.getState().refreshFromChangeFeed();

    expect(get).toHaveBeenCalledWith({ since: 5, feedId: "feed-1" });
    expect(snapshot).not.toHaveBeenCalled();
    const notes = useCairnStore.getState().notes;
    expect(notes.map((n) => n.title)).toEqual(["new", "keep"]);
    expect(notes[1]).toBe(keep); // untouched row keeps identity
    expect(getChangeFeedCursor().seq).toBe(10);
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it("does nothing (and keeps undo history) for this window's own writes", async () => {
    const clear = vi.spyOn(historyManager, "clear");
    const before = useCairnStore.getState().notes;
    get.mockResolvedValueOnce(changeset({ touched: ["notes"], externalTouched: [] }));
    await useCairnStore.getState().refreshFromChangeFeed();
    expect(useCairnStore.getState().notes).toBe(before);
    expect(clear).not.toHaveBeenCalled();
    expect(getChangeFeedCursor().seq).toBe(10);
    clear.mockRestore();
  });

  it("falls back to a full snapshot when the feed requests a reset", async () => {
    get
      .mockResolvedValueOnce(changeset({ reset: true, head: 42, feedId: "feed-2" })) // since 5 → reset
      .mockResolvedValueOnce(changeset({ head: 42, feedId: "feed-2" }));             // cursor re-init
    snapshot.mockResolvedValueOnce({
      workspaces: useCairnStore.getState().workspaces,
      projects: [], columns: [], cards: [], tags: [],
      notes: [note("n9", "from snapshot")],
    });
    await useCairnStore.getState().refreshFromChangeFeed();
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(useCairnStore.getState().notes.map((n) => n.id)).toEqual(["n9"]);
    expect(getChangeFeedCursor()).toEqual({ feedId: "feed-2", seq: 42 });
  });
});
