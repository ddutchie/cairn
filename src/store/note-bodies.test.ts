/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Lazy note bodies (store/note-bodies.ts + notes slice): Electron keeps note
 * metadata in the store and loads bodies on demand.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useCairnStore } from "./index";
import { __resetNoteBodyCache, MAX_CACHED_BODIES, pinNoteBody } from "./note-bodies";
import { setChangeFeedCursor, type ChangeSet } from "./change-feed";
import { markOwnNoteWrite } from "./ipc";

const meta = (id: string, patch: Record<string, unknown> = {}) =>
  ({ id, projectId: "p1", workspaceId: "ws1", title: id, contentText: "", tagIds: [], linkedNoteIds: [], linkedCardIds: [], isPinned: false, type: "note", folder: "", createdAt: "2026-01-01", updatedAt: "2026-01-01", version: 1, ...patch }) as any;

describe("lazy note bodies", () => {
  const bodies = vi.fn();
  const changesGet = vi.fn();
  const del = vi.fn();
  let db: Record<string, string>;

  beforeEach(() => {
    __resetNoteBodyCache();
    db = {};
    bodies.mockReset().mockImplementation(async (ids: string[]) =>
      ids.filter((id) => id in db).map((id) => ({ id, content: db[id], version: 1, updatedAt: "x" })));
    changesGet.mockReset();
    del.mockReset().mockResolvedValue(undefined);
    (globalThis as any).window = { electron: { note: { bodies, delete: del }, changes: { get: changesGet } } };
    useCairnStore.setState({
      workspaces: [{ id: "ws1", name: "WS", createdAt: "2026-01-01", updatedAt: "2026-01-01" } as any],
      projects: [], columns: [], cards: [], tags: [], notes: [], noteChangeMarks: {},
      activeWorkspaceId: "ws1", graphLoaded: false,
    });
    setChangeFeedCursor("f", 1);
  });
  afterEach(() => { delete (globalThis as any).window; });

  it("loads a body on demand and coalesces concurrent requests", async () => {
    db.n1 = "hello";
    useCairnStore.setState({ notes: [meta("n1")] });
    const s = useCairnStore.getState();
    const [a, b] = await Promise.all([s.loadNoteBody("n1"), s.loadNoteBody("n1")]);
    expect(a).toBe("hello");
    expect(b).toBe("hello");
    expect(bodies).toHaveBeenCalledTimes(1);
    // Already loaded → no further IPC.
    await s.ensureNoteBodies(["n1"]);
    expect(bodies).toHaveBeenCalledTimes(1);
  });

  it("keeps a loaded body across a refresh and refetches it (with a change mark) when the note changed", async () => {
    db.n1 = "v1";
    useCairnStore.setState({ notes: [meta("n1")] });
    await useCairnStore.getState().loadNoteBody("n1");

    // External edit: the changeset carries metadata only (newer version).
    db.n1 = "v2";
    changesGet.mockResolvedValueOnce({
      feedId: "f", head: 2, reset: false, touched: ["notes"], externalTouched: ["notes"],
      upserts: { notes: [meta("n1", { version: 2, updatedAt: "2026-01-02" })] }, removed: {},
    } satisfies ChangeSet);
    await useCairnStore.getState().refreshFromChangeFeed();
    // Body kept immediately (no flash)…
    expect(useCairnStore.getState().notes[0].content).toBeDefined();
    // …then refreshed from the DB with a "what's new" mark.
    await vi.waitFor(() => expect(useCairnStore.getState().notes[0].content).toBe("v2"));
    expect(useCairnStore.getState().noteChangeMarks.n1?.previousContent).toBe("v1");
  });

  it("does not overwrite a body the user is typing in", async () => {
    db.n1 = "server";
    useCairnStore.setState({ notes: [meta("n1", { content: "typing…" })] });
    markOwnNoteWrite("n1");
    await useCairnStore.getState().ensureNoteBodies(["n1"], { force: true });
    expect(useCairnStore.getState().notes[0].content).toBe("typing…");
  });

  it("evicts least-recently-used unpinned bodies beyond the cache limit", async () => {
    // Fresh ids: other tests mark n* notes as recently own-written (kept).
    const n = MAX_CACHED_BODIES + 5;
    const notes = Array.from({ length: n }, (_, i) => meta(`e${i}`));
    for (let i = 0; i < n; i++) db[`e${i}`] = `body ${i}`;
    useCairnStore.setState({ notes });
    pinNoteBody("e0"); // e.g. the open editor
    for (let i = 0; i < n; i++) await useCairnStore.getState().ensureNoteBodies([`e${i}`]);
    const loaded = useCairnStore.getState().notes.filter((x) => x.content !== undefined).map((x) => x.id);
    expect(loaded.length).toBeLessThanOrEqual(MAX_CACHED_BODIES + 1);
    expect(loaded).toContain("e0");            // pinned survives
    expect(loaded).toContain(`e${n - 1}`);     // most recent survives
    expect(loaded).not.toContain("e1");        // oldest unpinned evicted
  });

  it("reads the body before deleting an unloaded note, so undo restores content", async () => {
    db.n1 = "precious";
    useCairnStore.setState({ notes: [meta("n1")] });
    useCairnStore.getState().deleteNote("n1");
    expect(useCairnStore.getState().notes).toEqual([]); // optimistic removal
    await vi.waitFor(() => expect(del).toHaveBeenCalledWith("n1"));
    expect(bodies).toHaveBeenCalledWith(["n1"]);
    // bodies() resolved before delete() was sent.
    expect(bodies.mock.invocationCallOrder[0]).toBeLessThan(del.mock.invocationCallOrder[0]);
  });
});
