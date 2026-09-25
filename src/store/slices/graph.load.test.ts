/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Regression tests for loadGraph's background-refresh behaviour (graph.ts):
 * a silent refresh must not toggle `graphLoading` (that flashed the
 * "Loading graph…" overlay every few seconds), and an unchanged payload must
 * keep graphData's identity so canvases don't rebuild or reset their state.
 */

import { describe, it, expect, vi } from "vitest";

const graphGet = vi.fn();
vi.mock("../ipc", () => ({
  ipcData: (fn: (e: any) => Promise<unknown>) => fn({ graph: { get: graphGet } }),
  ipcAwait: vi.fn(),
}));

import { createGraphSlice, DEFAULT_GRAPH_FILTERS } from "./graph";

function setup() {
  let state: any = { activeWorkspaceId: "ws-1" };
  const loadingHistory: boolean[] = [];
  const mockSet = (updater: any) => {
    const next = typeof updater === "function" ? updater(state) : updater;
    if ("graphLoading" in next) loadingHistory.push(next.graphLoading);
    state = { ...state, ...next };
  };
  const slice = createGraphSlice(mockSet, () => state, {} as any);
  state = { ...state, ...slice, graphFilters: DEFAULT_GRAPH_FILTERS };
  return { get: () => state, loadingHistory };
}

const graphA = () => ({ nodes: [{ id: "n1", type: "note", title: "A" }], edges: [] });
const graphB = () => ({ nodes: [{ id: "n1", type: "note", title: "B" }], edges: [] });

describe("loadGraph background refresh", () => {
  it("keeps graphData identity when a refresh returns an identical payload", async () => {
    const { get } = setup();
    graphGet.mockResolvedValueOnce(graphA());
    await get().loadGraph("ws-1");
    const first = get().graphData;
    expect(first.nodes[0].title).toBe("A");

    graphGet.mockResolvedValueOnce(graphA());
    await get().loadGraph("ws-1", { silent: true });
    expect(get().graphData).toBe(first);
  });

  it("commits changed data on a silent refresh without toggling graphLoading", async () => {
    const { get, loadingHistory } = setup();
    graphGet.mockResolvedValueOnce(graphA());
    await get().loadGraph("ws-1");
    loadingHistory.length = 0;

    graphGet.mockResolvedValueOnce(graphB());
    await get().loadGraph("ws-1", { silent: true });
    expect(get().graphData.nodes[0].title).toBe("B");
    expect(loadingHistory.every((v) => v === false)).toBe(true);
    expect(get().graphLoading).toBe(false);
  });
});
