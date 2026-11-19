import { describe, it, expect } from "vitest";
import { rememberLayout, recallLayout, recallTopology } from "./force-layout-client";

describe("remembered layouts", () => {
  const pos = (x: number) => new Map([["a", { x, y: 0 }]]);

  it("records the topology a settled layout was remembered with", () => {
    rememberLayout("t1", pos(1), "topo-a");
    expect(recallTopology("t1")).toBe("topo-a");
    expect(recallLayout("t1")?.get("a")).toEqual({ x: 1, y: 0 });
  });

  it("keeps the topology when none is given and clears it on null", () => {
    rememberLayout("t2", pos(1), "topo-a");
    rememberLayout("t2", pos(2));
    expect(recallTopology("t2")).toBe("topo-a");
    rememberLayout("t2", pos(3), null);
    expect(recallTopology("t2")).toBeUndefined();
    expect(recallLayout("t2")?.get("a")).toEqual({ x: 3, y: 0 });
  });
});
