import { describe, it, expect } from "vitest";
import { runForceLayout, type LayoutInit } from "./force-layout";

function ring(n: number, seeded: boolean): LayoutInit {
  return {
    gen: 1,
    spacing: 1,
    nodes: Array.from({ length: n }, (_, i) => ({
      id: `n${i}`,
      nodeType: i === 0 ? "project" as const : "note" as const,
      projectId: i === 0 ? undefined : "n0",
      ...(seeded ? { x: Math.cos(i) * 100, y: Math.sin(i) * 100 } : {}),
    })),
    links: Array.from({ length: n - 1 }, (_, i) => ({ source: 0, target: i + 1, edgeType: "project-member" })),
  };
}

function settle(init: LayoutInit): Promise<{ frames: Float32Array[] }> {
  return new Promise((resolve) => {
    const frames: Float32Array[] = [];
    runForceLayout(init, (p) => frames.push(p), () => resolve({ frames }));
  });
}

describe("runForceLayout", () => {
  it("posts finite positions for every node and settles", async () => {
    const { frames } = await settle(ring(30, false));
    const last = frames[frames.length - 1];
    expect(last.length).toBe(60);
    expect(Array.from(last).every(Number.isFinite)).toBe(true);
  });

  it("re-heats gently when nearly every node keeps its position", async () => {
    const fresh = await settle(ring(30, false));
    const seeded = await settle(ring(30, true));
    expect(seeded.frames.length).toBeLessThan(fresh.frames.length);
  });

  it("stops posting after stop()", async () => {
    let count = 0;
    const layout = runForceLayout(ring(10, false), () => count++, () => {});
    layout.stop();
    const before = count;
    await new Promise((r) => setTimeout(r, 50));
    expect(count).toBe(before);
  });
});
