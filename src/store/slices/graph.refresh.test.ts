/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Regression tests for refreshGraphIfLoaded's trailing debounce (graph.ts).
 *
 * Uses the same mockSet/mockGet store harness as src/store/slices/ui.test.ts,
 * with loadGraph replaced by a vi.fn() so the debounce logic is exercised
 * without IPC/Electron. Fake timers control the 1200ms trailing window.
 *
 * NOTE: graphRefreshTimer/graphRefreshQueued are module-level, so every test
 * flushes its pending timer (advanceTimersByTime past the debounce) and
 * afterEach clears timers; the queue-flag test runs last.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createGraphSlice } from "./graph";

const DEBOUNCE_MS = 1200;

function setup(initial: any = {}) {
  let state: any = {
    graphData: { nodes: [], edges: [] },
    graphLoading: false,
    graphError: null,
    graphLoaded: false,
    graphLayout: "force",
    activeWorkspaceId: "ws-1",
    ...initial,
  };
  const mockSet = (updater: any) => {
    const next = typeof updater === "function" ? updater(state) : updater;
    state = { ...state, ...next };
  };
  const mockGet = () => state;
  const slice = createGraphSlice(mockSet, mockGet, {} as any);
  state = { ...state, ...slice, ...initial };
  // Swap the real (IPC-backed) loadGraph for a mock: refreshGraphIfLoaded
  // reads it via get() at fire time, so this intercepts the debounced call.
  const loadGraph = vi.fn(async (_ws: string) => {});
  state = { ...state, loadGraph };
  return { get: () => state, loadGraph };
}

describe("refreshGraphIfLoaded debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("no-ops when the graph was never loaded", async () => {
    const { get, loadGraph } = setup({ graphLoaded: false });
    await get().refreshGraphIfLoaded();
    vi.advanceTimersByTime(DEBOUNCE_MS + 1000);
    expect(loadGraph).not.toHaveBeenCalled();
  });

  it("no-ops when there is no active workspace", async () => {
    const { get, loadGraph } = setup({ graphLoaded: true, activeWorkspaceId: null });
    await get().refreshGraphIfLoaded();
    vi.advanceTimersByTime(DEBOUNCE_MS + 1000);
    expect(loadGraph).not.toHaveBeenCalled();
  });

  it("coalesces a burst of rapid calls into ONE loadGraph", async () => {
    const { get, loadGraph } = setup({ graphLoaded: true });
    for (let i = 0; i < 5; i++) {
      await get().refreshGraphIfLoaded();
      vi.advanceTimersByTime(200); // saves landing ~300ms apart while typing
    }
    // 1000ms elapsed since the first call but only 200ms since the last —
    // the trailing timer must not have fired yet.
    expect(loadGraph).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DEBOUNCE_MS - 200);
    expect(loadGraph).toHaveBeenCalledTimes(1);
    expect(loadGraph).toHaveBeenCalledWith("ws-1");
    // Settling further fires nothing more.
    vi.advanceTimersByTime(5000);
    expect(loadGraph).toHaveBeenCalledTimes(1);
  });

  it("fires a second load for a later, separate burst", async () => {
    const { get, loadGraph } = setup({ graphLoaded: true });
    await get().refreshGraphIfLoaded();
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(loadGraph).toHaveBeenCalledTimes(1);

    await get().refreshGraphIfLoaded();
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(loadGraph).toHaveBeenCalledTimes(2);
  });

  it("defers while a load is in flight instead of firing loadGraph", async () => {
    const { get, loadGraph } = setup({ graphLoaded: true, graphLoading: true });
    await get().refreshGraphIfLoaded();
    vi.advanceTimersByTime(DEBOUNCE_MS + 1000);
    // Queued for the in-flight load's completion (handled in loadGraph's
    // finally) — no direct loadGraph call from the debounce itself.
    expect(loadGraph).not.toHaveBeenCalled();
  });
});
