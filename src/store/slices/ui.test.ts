/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { createUISlice } from "./ui";

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
    expect(state.activeView).toBe("board");
    expect(state.lastContentView).toBe("board");

    // Set active project
    state.setActiveProject("p1");
    expect(state.activeView).toBe("overview");
    expect(state.lastContentView).toBe("overview");

    // Navigate back to board
    state.setView("board");
    expect(state.lastContentView).toBe("board");

    // Set active workspace
    state.setActiveWorkspace("w2");
    expect(state.activeView).toBe("overview");
    expect(state.lastContentView).toBe("overview");
  });
});
