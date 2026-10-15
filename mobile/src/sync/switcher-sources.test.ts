import { describe, expect, it } from "vitest";
import { mergeSwitcherSources } from "./switcher-sources";

const a = { workspaceId: "ws-a", name: "Alpha" };
const b = { workspaceId: "ws-b", name: "Beta" };

describe("mergeSwitcherSources", () => {
  it("lists the active workspace even when the folder scan found nothing", () => {
    // Regression: an empty list left the native switcher menu unopenable.
    expect(mergeSwitcherSources([], b)).toEqual([b]);
  });

  it("merges scanned, active and extra sources, sorted by name", () => {
    const demo = { workspaceId: "dev-demo-workspace", name: "Demo" };
    expect(mergeSwitcherSources([b], a, [demo])).toEqual([a, b, demo]);
  });

  it("prefers the scanned entry over the injected active stub", () => {
    expect(mergeSwitcherSources([a], { workspaceId: "ws-a", name: null })).toEqual([a]);
  });

  it("falls back to the id for unnamed sources and returns [] with nothing active", () => {
    expect(mergeSwitcherSources([], null)).toEqual([]);
    const unnamed = { workspaceId: "aaa", name: null };
    expect(mergeSwitcherSources([b], unnamed)).toEqual([unnamed, b]);
  });
});
