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
  return { get: () => state, setState: (patch: any) => { state = { ...state, ...patch }; }, loadingHistory };
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

  it("records which workspace produced graphData", async () => {
    const { get } = setup();
    graphGet.mockResolvedValueOnce(graphA());
    await get().loadGraph("ws-1");
    expect(get().graphWorkspaceId).toBe("ws-1");
  });

  it("drops a response that arrives after the workspace changed", async () => {
    const { get, setState } = setup();
    let resolveA!: (v: unknown) => void;
    graphGet.mockReturnValueOnce(new Promise((r) => { resolveA = r; }));
    const pending = get().loadGraph("ws-1");
    setState({ activeWorkspaceId: "ws-2" }); // user switched mid-load
    resolveA(graphA());
    await pending;
    expect(get().graphData.nodes).toEqual([]);
    expect(get().graphWorkspaceId).toBeNull();
    expect(get().graphLoading).toBe(false); // not stuck on
  });

  it("a failed silent refresh keeps the graph on screen (no graphError)", async () => {
    const { get } = setup();
    graphGet.mockResolvedValueOnce(graphA());
    await get().loadGraph("ws-1");
    const shown = get().graphData;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    graphGet.mockRejectedValueOnce(new Error("db busy"));
    await get().loadGraph("ws-1", { silent: true });
    expect(get().graphError).toBeNull();
    expect(get().graphData).toBe(shown);
    warn.mockRestore();
  });

  it("a failed user-visible load still reports graphError", async () => {
    const { get } = setup();
    graphGet.mockRejectedValueOnce(new Error("db busy"));
    await get().loadGraph("ws-1");
    expect(get().graphError).toBe("db busy");
  });
});
