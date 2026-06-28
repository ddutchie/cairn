/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createUISlice, SEEN_FEATURES_KEY } from "./ui";

// Mock the persistence layer so we can assert markFeatureAsSeen's storage
// contract (node project has no window, so storage.set is otherwise a no-op).
const storageSet = vi.fn();
vi.mock("@/lib/storage", () => ({
  storage: {
    get: vi.fn(() => null),
    set: (...args: unknown[]) => storageSet(...args),
    delete: vi.fn(),
    clear: vi.fn(),
  },
}));

describe("createUISlice", () => {
  it("initializes with overview as activeView and lastContentView", () => {
    let state: any = {};

    const mockSet = (updater: any) => {
      const next = typeof updater === "function" ? updater(state) : updater;
      state = { ...state, ...next };
    };
    const mockGet = () => state;

    const slice = createUISlice(mockSet, mockGet, {} as any);
    state = { ...state, ...slice };

    expect(state.activeView).toBe("overview");
    expect(state.lastContentView).toBe("overview");
  });

  it("setView updates activeView and lastContentView for content views", () => {
    let state: any = {};

    const mockSet = (updater: any) => {
      const next = typeof updater === "function" ? updater(state) : updater;
      state = { ...state, ...next };
    };
    const mockGet = () => state;

    const slice = createUISlice(mockSet, mockGet, {} as any);
    state = { ...state, ...slice };

    // Navigate to board (a content view)
    state.setView("board");
    expect(state.activeView).toBe("board");
    expect(state.lastContentView).toBe("board");

    // Navigate to notes (a content view)
    state.setView("notes");
    expect(state.activeView).toBe("notes");
    expect(state.lastContentView).toBe("notes");
  });

  it("setView does not update lastContentView when entering chat or search mode", () => {
    let state: any = {};

    const mockSet = (updater: any) => {
      const next = typeof updater === "function" ? updater(state) : updater;
      state = { ...state, ...next };
    };
    const mockGet = () => state;

    const slice = createUISlice(mockSet, mockGet, {} as any);
    state = { ...state, ...slice };

    // Set a baseline content view
    state.setView("board");
    expect(state.activeView).toBe("board");
    expect(state.lastContentView).toBe("board");

    // Switch to chat
    state.setView("chat");
    expect(state.activeView).toBe("chat");
    expect(state.lastContentView).toBe("board"); // remains "board"

    // Switch to search
    state.setView("search");
    expect(state.activeView).toBe("search");
    expect(state.lastContentView).toBe("board"); // remains "board"
  });

  it("setActiveWorkspace and setActiveProject reset lastContentView to overview", () => {
    let state: any = {
      projects: [
        { id: "p1", workspaceId: "w1" },
        { id: "p2", workspaceId: "w2" },
      ],
    };

    const mockSet = (updater: any) => {
      const next = typeof updater === "function" ? updater(state) : updater;
      state = { ...state, ...next };
    };
    const mockGet = () => state;

    const slice = createUISlice(mockSet, mockGet, {} as any);
    state = { ...state, ...slice };

    // Set a baseline
    state.setView("board");
    state.setActivePreviewItem({ type: "note", id: "note-1" });
    expect(state.activeView).toBe("board");
    expect(state.lastContentView).toBe("board");
    expect(state.activePreviewItem).toEqual({ type: "note", id: "note-1" });

    // Set active project
    state.setActiveProject("p1");
    expect(state.activeView).toBe("overview");
    expect(state.lastContentView).toBe("overview");
    expect(state.activePreviewItem).toBeNull();

    // Navigate back to board and set a preview item
    state.setView("board");
    state.setActivePreviewItem({ type: "task", id: "card-1" });
    expect(state.lastContentView).toBe("board");
    expect(state.activePreviewItem).toEqual({ type: "task", id: "card-1" });

    // Set active workspace
    state.setActiveWorkspace("w2");
    expect(state.activeView).toBe("overview");
    expect(state.lastContentView).toBe("overview");
    expect(state.activePreviewItem).toBeNull();
  });
});

// ── Tour / What's New feature state ──────────────────────────────────────────

describe("createUISlice — tour & seen-features state", () => {
  beforeEach(() => {
    storageSet.mockClear();
  });

  function setup() {
    let state: any = {};
    const mockSet = (updater: any) => {
      const next = typeof updater === "function" ? updater(state) : updater;
      state = { ...state, ...next };
    };
    const mockGet = () => state;
    const slice = createUISlice(mockSet, mockGet, {} as any);
    state = { ...state, ...slice };
    return { get: () => state };
  }

  it("initializes tour/feature state to defaults", () => {
    const { get } = setup();
    expect(get().seenFeatures).toEqual([]);
    expect(get().tutorialActive).toBe(false);
    expect(get().tutorialStepIndex).toBe(0);
  });

  it("markFeatureAsSeen appends an unseen feature id", () => {
    const { get } = setup();
    get().markFeatureAsSeen("v2.3.2-onboarding-tour");
    expect(get().seenFeatures).toEqual(["v2.3.2-onboarding-tour"]);
    // Persists the new array under the seen-features key.
    expect(storageSet).toHaveBeenLastCalledWith(SEEN_FEATURES_KEY, ["v2.3.2-onboarding-tour"]);
  });

  it("markFeatureAsSeen is idempotent for an already-seen id", () => {
    const { get } = setup();
    get().markFeatureAsSeen("a");
    get().markFeatureAsSeen("a");
    expect(get().seenFeatures).toEqual(["a"]);
    // Re-persists the unchanged array (no duplicate id).
    expect(storageSet).toHaveBeenLastCalledWith(SEEN_FEATURES_KEY, ["a"]);
  });

  it("markFeatureAsSeen accumulates distinct ids in order", () => {
    const { get } = setup();
    get().markFeatureAsSeen("a");
    get().markFeatureAsSeen("b");
    get().markFeatureAsSeen("a"); // duplicate, ignored
    get().markFeatureAsSeen("c");
    expect(get().seenFeatures).toEqual(["a", "b", "c"]);
    // Final persisted value matches the in-memory ordered set.
    expect(storageSet).toHaveBeenLastCalledWith(SEEN_FEATURES_KEY, ["a", "b", "c"]);
  });

  it("setTutorialActive(true) activates the tour and resets the step index", () => {
    const { get } = setup();
    // Advance the step first so the reset side-effect is observable.
    get().setTutorialStepIndex(3);
    expect(get().tutorialStepIndex).toBe(3);

    get().setTutorialActive(true);
    expect(get().tutorialActive).toBe(true);
    expect(get().tutorialStepIndex).toBe(0); // reset on activate
  });

  it("setTutorialActive(false) deactivates the tour and resets the step index", () => {
    const { get } = setup();
    get().setTutorialStepIndex(2);
    get().setTutorialActive(false);
    expect(get().tutorialActive).toBe(false);
    expect(get().tutorialStepIndex).toBe(0);
  });

  it("setTutorialStepIndex updates the step index", () => {
    const { get } = setup();
    get().setTutorialStepIndex(4);
    expect(get().tutorialStepIndex).toBe(4);
  });
});
