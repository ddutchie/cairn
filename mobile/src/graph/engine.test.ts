import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GraphNode, GraphEdge } from "@/db/types";
import { GraphEngine } from "./engine";
import { recordForceScene, recordRadialScene } from "./scene";
import { worldToScreen, type Camera } from "./camera";

vi.mock("@/haptics", () => ({ haptics: { selection: vi.fn(), impact: vi.fn() } }));
vi.mock("./scene", () => ({
  recordForceScene: vi.fn(() => ({ kind: "force" })),
  recordRadialScene: vi.fn(() => ({ kind: "radial" })),
}));

const n = (id: string, type: GraphNode["type"], projectId?: string): GraphNode => ({ id, type, title: id, projectId });
const e = (source: string, target: string): GraphEdge => ({ source, target, type: "project-member" });
const data = {
  nodes: [n("p1", "project"), n("a", "note", "p1"), n("b", "note", "p1"), n("c", "card", "p1"), n("p2", "project"), n("d", "note", "p2")],
  edges: [e("p1", "a"), e("p1", "b"), e("p1", "c"), e("p2", "d")],
};

let now = 0;
let queue: FrameRequestCallback[] = [];
/** Run frames until the engine goes to sleep (or a cap, to catch a runaway loop). */
function settle(maxFrames = 2000): number {
  let frames = 0;
  while (queue.length && frames < maxFrames) {
    const q = queue;
    queue = [];
    now += 16;
    for (const cb of q) cb(now);
    frames++;
  }
  return frames;
}

beforeEach(() => {
  now = 0;
  queue = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    queue = [];
  });
  vi.stubGlobal("performance", { now: () => now });
  vi.mocked(recordForceScene).mockClear();
  vi.mocked(recordRadialScene).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

function make(mode: "force" | "radial" = "force", reducedMotion = false) {
  const cams: Camera[] = [];
  const pics: unknown[] = [];
  const picked: { id: string; type: string }[] = [];
  const engine = new GraphEngine(
    { onPicture: (p) => pics.push(p), onCamera: (c) => cams.push(c) },
    {} as never,
    { mode, labelMode: "smart", showHulls: true, reducedMotion },
  );
  engine.onSelectNode = (x) => picked.push(x);
  engine.setGraph(data);
  engine.setSize(400, 800);
  return { engine, cams, pics, picked };
}

describe("GraphEngine (force)", () => {
  it("settles, auto-fits once, then goes to sleep", () => {
    const { engine, cams, pics } = make();
    const frames = settle();
    expect(frames).toBeGreaterThan(5);
    expect(frames).toBeLessThan(2000); // the loop sleeps when nothing moves
    expect(pics.length).toBeGreaterThan(0);
    // fit animation ended on a camera that frames the graph
    const last = cams[cams.length - 1];
    expect(last.k).toBeGreaterThan(0.2);
    expect(queue).toHaveLength(0);
    engine.dispose();
  });

  it("does not auto-fit after the user has panned", () => {
    const { engine, cams } = make();
    engine.panBegin(5, 5); // empty space
    engine.panStart();
    engine.panMove(5, 5, 40, 20);
    engine.panEnd();
    const manual = cams[cams.length - 1];
    settle();
    expect(cams[cams.length - 1]).toEqual(manual);
    engine.dispose();
  });

  it("dragging a node pins it under the finger and keeps the sim awake", () => {
    const { engine, cams } = make();
    settle();
    const cam = cams[cams.length - 1];
    // project p1 is rendered somewhere; find it through the recorded scene input
    const input = vi.mocked(recordForceScene).mock.calls.at(-1)![0];
    const p1 = input.nodes.find((x) => x.id === "p1")!;
    const s = worldToScreen(cam, p1.x, p1.y);
    engine.panBegin(s.x, s.y);
    engine.panStart();
    engine.panMove(s.x + 100, s.y, 100, 0);
    settle(5);
    const moved = worldToScreen(cam, p1.x, p1.y);
    expect(moved.x).toBeCloseTo(s.x + 100, 0);
    engine.panEnd();
    engine.dispose();
  });

  it("tapping a node selects it and notifies the host; empty space deselects", () => {
    const { engine, cams, picked } = make();
    settle();
    const cam = cams[cams.length - 1];
    const input = vi.mocked(recordForceScene).mock.calls.at(-1)![0];
    const a = input.nodes.find((x) => x.id === "a")!;
    const s = worldToScreen(cam, a.x, a.y);
    engine.tap(s.x, s.y);
    expect(picked).toEqual([{ id: "a", type: "note" }]);
    settle();
    expect(vi.mocked(recordForceScene).mock.calls.at(-1)![0].selectedId).toBe("a");
    engine.tap(-500, -500);
    settle();
    expect(vi.mocked(recordForceScene).mock.calls.at(-1)![0].selectedId).toBeNull();
    engine.dispose();
  });

  it("pauses while inactive and resumes", () => {
    const { engine } = make();
    engine.setActive(false);
    expect(queue).toHaveLength(0);
    engine.setActive(true);
    expect(queue.length).toBeGreaterThan(0);
    engine.dispose();
  });

  it("reduced motion settles instantly without a frame loop for the sim", () => {
    const { engine, cams } = make("force", true);
    settle();
    expect(cams.length).toBeGreaterThan(0);
    // a single record is enough; no long-running simulation frames
    expect(vi.mocked(recordForceScene).mock.calls.length).toBeLessThan(5);
    engine.dispose();
  });

  it("swapping only edges keeps node positions", () => {
    const { engine } = make();
    settle();
    const before = vi.mocked(recordForceScene).mock.calls.at(-1)![0].nodes.map((x) => [x.x, x.y]);
    engine.setGraph({ nodes: data.nodes, edges: [...data.edges, { source: "a", target: "d", type: "semantic", weight: 0.8 }] });
    const after = vi.mocked(recordForceScene).mock.calls.at(-1)![0].nodes.map((x) => [x.x, x.y]);
    expect(after).toEqual(before);
    engine.dispose();
  });

  it("pinch zooms about the focal point", () => {
    const { engine, cams } = make();
    settle();
    const before = cams[cams.length - 1];
    engine.pinchStart(200, 400);
    engine.pinchMove(2, 200, 400);
    const after = cams[cams.length - 1];
    expect(after.k).toBeCloseTo(before.k * 2);
    // focal world point stays under the focal screen point
    const w = { x: (200 - before.tx) / before.k, y: (400 - before.ty) / before.k };
    expect(w.x * after.k + after.tx).toBeCloseTo(200);
    expect(w.y * after.k + after.ty).toBeCloseTo(400);
    engine.dispose();
  });
});

describe("GraphEngine (radial)", () => {
  it("renders the sunburst and drills into a project on tap, then back via the hub", () => {
    const { engine, picked } = make("radial");
    settle();
    expect(recordRadialScene).toHaveBeenCalled();
    const first = vi.mocked(recordRadialScene).mock.calls.at(-1)![0];
    expect(first.isRoot).toBe(true);
    const w = first.arcs.find((a) => a.node.data.id === "p1")!;
    const mid = (w.x0 + w.x1) / 2;
    const r = (w.r0 + w.r1) / 2;
    engine.tap(200 + r * Math.sin(mid), 400 - r * Math.cos(mid));
    expect(picked.at(-1)).toEqual({ id: "p1", type: "project" });
    settle();
    const drilled = vi.mocked(recordRadialScene).mock.calls.at(-1)![0];
    expect(drilled.isRoot).toBe(false);
    expect(drilled.focus.data.id).toBe("p1");
    // hub goes back up
    engine.tap(200, 400);
    settle();
    expect(vi.mocked(recordRadialScene).mock.calls.at(-1)![0].isRoot).toBe(true);
    engine.dispose();
  });

  it("switching mode rebuilds and resets the camera for radial", () => {
    const { engine, cams } = make("force");
    settle();
    engine.setOptions({ mode: "radial", labelMode: "smart", showHulls: true, reducedMotion: false });
    expect(cams[cams.length - 1]).toEqual({ k: 1, tx: 0, ty: 0 });
    settle();
    expect(recordRadialScene).toHaveBeenCalled();
    engine.setOptions({ mode: "force", labelMode: "smart", showHulls: true, reducedMotion: false });
    settle();
    expect(recordForceScene).toHaveBeenCalled();
    engine.dispose();
  });
});
