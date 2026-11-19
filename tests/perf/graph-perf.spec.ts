/**
 * Knowledge Graph canvas benchmark (force + radial) on a large graph.
 *
 * Boots the real renderer with the mocked IPC (same mock as the marketing
 * screenshots), swaps in a 476-node / 2756-edge graph, then drives the
 * interactions that feel slow — panning, wheel zoom, hovering, selecting,
 * and drilling into the radial view — and reports per-frame timing, how much
 * of each frame is JS inside rAF callbacks, 2D-canvas call counts, and the
 * hottest functions from a CPU profile.
 *
 * Each "variant" reloads the page with one thing changed (a view setting, or
 * a canvas feature switched off via the frame probe), so the difference to
 * the baseline is what that thing costs.
 *
 * Run:  npm run bench:graph-ui
 *       GRAPH_JSON=/path/to/graph.json npm run bench:graph-ui   (real graph)
 *       DPR=1 npm run bench:graph-ui                            (1x display)
 *       ONLY=force|radial npm run bench:graph-ui
 *       HEADED=1 npm run bench:graph-ui                         (real GPU)
 *       CPU_THROTTLE=4 npm run bench:graph-ui                   (≈ slower PC)
 *       VARIANTS="force baseline;radial baseline" npm run bench:graph-ui
 *
 * Results print as tables and are written to test-results/graph-perf/.
 */

import { test, type Page, type CDPSession } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { loadBenchGraph } from "./large-graph";
import type { PerfFlags, ProbeResult } from "./frame-probe";
import {
  OUT_DIR, pct, sum, r1, bootApp, showGraph, waitForGraphData, canvasBox, assertCanvasReachable,
  type StoreWindow,
} from "./harness";

const { graph, source } = loadBenchGraph();
const DPR = Number(process.env.DPR ?? 2);
const ONLY = process.env.ONLY;
/** Slow the renderer's CPU N× (CDP throttling) to approximate a slower machine. */
const CPU_THROTTLE = Number(process.env.CPU_THROTTLE ?? 1);
/** Semicolon-separated variant names to run (default: all). */
const VARIANT_FILTER = process.env.VARIANTS?.split(";").map((s) => s.trim());

type Layout = "force" | "radial";

interface Variant {
  name: string;
  layout: Layout;
  /** localStorage entries read by KnowledgeGraphView on mount. */
  storage?: Record<string, string>;
  flags?: PerfFlags;
  dpr?: number;
  /** Capture a CPU profile per scenario (baseline only — it adds overhead). */
  profile?: boolean;
}

const VARIANTS: Variant[] = ([
  { name: "force baseline", layout: "force", profile: true },
  { name: "force no dashed lines", layout: "force", flags: { noDash: true } },
  { name: "force no hulls", layout: "force", storage: { "kg-hulls": "false" } },
  { name: "force no text", layout: "force", flags: { noText: true } },
  { name: "force labels: all", layout: "force", storage: { "kg-label-mode": "all" } },
  { name: "force semantic ≥ 0.5", layout: "force", storage: { "kg-semantic-threshold": "0.5" } },
  { name: "force semantic ≥ 0.5, no dash", layout: "force", storage: { "kg-semantic-threshold": "0.5" }, flags: { noDash: true } },
  { name: "force dpr 1", layout: "force", dpr: 1 },
  { name: "radial baseline", layout: "radial", profile: true },
  { name: "radial no text", layout: "radial", flags: { noText: true } },
  { name: "radial no shadow", layout: "radial", flags: { noShadow: true } },
  { name: "radial dpr 1", layout: "radial", dpr: 1 },
] satisfies Variant[] as Variant[]).filter((v) => (!ONLY || v.layout === ONLY) && (!VARIANT_FILTER || VARIANT_FILTER.includes(v.name)));

// ── stats ────────────────────────────────────────────────────────────────────

interface Row {
  variant: string;
  scenario: string;
  fps: number;
  "frame p50": number;
  "frame p95": number;
  "frame max": number;
  "janky %": number;
  "rAF JS p50": number;
  "rAF JS p95": number;
  "long tasks": number;
  "long task ms": number;
  calls: string;
}

function summarise(variant: string, scenario: string, r: ProbeResult): Row {
  const iv = r.intervals;
  const perFrame = (n = 0) => (r.frames ? r1(n / r.frames) : 0);
  const c = r.calls;
  return {
    variant,
    scenario,
    fps: r1(r.frames / (r.durationMs / 1000)),
    "frame p50": r1(pct(iv, 50)),
    "frame p95": r1(pct(iv, 95)),
    "frame max": r1(Math.max(0, ...iv)),
    // A frame over 1.5 × 16.7ms means at least one missed vsync.
    "janky %": iv.length ? Math.round((iv.filter((x) => x > 25).length / iv.length) * 100) : 0,
    "rAF JS p50": r1(pct(r.rafCallbackMs, 50)),
    "rAF JS p95": r1(pct(r.rafCallbackMs, 95)),
    "long tasks": r.longTasks,
    "long task ms": Math.round(r.longTaskMs),
    calls: `stroke ${perFrame(c.stroke)}/f fill ${perFrame(c.fill)}/f text ${perFrame((c.fillText ?? 0) + (c.strokeText ?? 0))}/f dash ${perFrame(c.setLineDash)}/f`,
  };
}

// ── CPU profile → hottest functions ──────────────────────────────────────────

interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number }

function topFunctions(profile: { nodes: ProfileNode[]; startTime: number; endTime: number; samples?: number[] }, n = 15) {
  const busy = (x: ProfileNode) => x.callFrame.functionName !== "(idle)" && x.callFrame.functionName !== "(program)";
  // Share of busy main-thread time (idle excluded).
  const total = sum(profile.nodes.filter(busy).map((x) => x.hitCount ?? 0)) || 1;
  const ms = (profile.endTime - profile.startTime) / 1000;
  const allHits = sum(profile.nodes.map((x) => x.hitCount ?? 0)) || 1;
  const self = new Map<string, number>();
  for (const node of profile.nodes) {
    const { functionName, url, lineNumber } = node.callFrame;
    const file = url ? url.split("/").pop()!.split("?")[0] : "";
    const key = `${functionName || "(anonymous)"} ${file ? `${file}:${lineNumber + 1}` : ""}`.trim();
    self.set(key, (self.get(key) ?? 0) + (node.hitCount ?? 0));
  }
  return [...self.entries()]
    .filter(([k]) => k !== "(idle)" && k !== "(program)")
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([fn, hits]) => ({ fn, "self %": r1((hits / total) * 100), "self ms": Math.round((hits / allHits) * ms) }));
}

// ── page helpers ─────────────────────────────────────────────────────────────

async function openGraph(page: Page, v: Variant) {
  await bootApp(page, graph, { flags: v.flags, storage: v.storage });
  await showGraph(page, v.layout);
  await waitForGraphData(page);
  await page.waitForTimeout(400);
  await assertCanvasReachable(page);
}

// ── Chrome trace → where main-thread time goes (JS vs style/layout/paint) ─────

interface TraceEvent { name: string; ph: string; pid: number; tid: number; ts: number; dur?: number; args?: { name?: string } }

/** Main-thread work grouped by kind: total ms over the measurement window. */
function traceBreakdown(buf: Buffer) {
  const events = (JSON.parse(buf.toString("utf8")).traceEvents ?? []) as TraceEvent[];
  const main = events.find((e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain");
  if (!main) return [];
  const onMain = events.filter((e) => e.ph === "X" && e.pid === main.pid && e.tid === main.tid && e.dur != null);
  const GROUPS: Record<string, string> = {
    FunctionCall: "script", EvaluateScript: "script", EventDispatch: "script (events)", FireAnimationFrame: "script (rAF)",
    TimerFire: "script (timers)", "v8.execute": "script",
    UpdateLayoutTree: "style recalc", Layout: "layout", HitTest: "hit test",
    PrePaint: "pre-paint", Paint: "paint", Layerize: "layerize", Commit: "commit",
    "Canvas2DLayerBridge::FlushRecording": "canvas flush", "CanvasResourceProvider::FlushCanvas": "canvas flush",
    MajorGC: "gc", MinorGC: "gc", "V8.GC_SCAVENGER": "gc",
  };
  const totals = new Map<string, { ms: number; count: number }>();
  for (const e of onMain) {
    const g = GROUPS[e.name];
    if (!g) continue;
    const t = totals.get(g) ?? { ms: 0, count: 0 };
    t.ms += e.dur! / 1000; t.count++;
    totals.set(g, t);
  }
  const busy = sum(onMain.filter((e) => e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask").map((e) => e.dur! / 1000));
  return [
    { kind: "main thread busy (all tasks)", ms: Math.round(busy), count: 0 },
    ...[...totals].sort((a, b) => b[1].ms - a[1].ms).map(([kind, t]) => ({ kind, ms: Math.round(t.ms), count: t.count })),
  ];
}

const TRACE_CATEGORIES = ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink", "v8", "toplevel", "disabled-by-default-v8.gc"];

async function measure(page: Page, cdp: CDPSession | null, action: () => Promise<void>) {
  const browser = page.context().browser();
  if (cdp && browser) await browser.startTracing(page, { categories: TRACE_CATEGORIES });
  if (cdp) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
  }
  await page.evaluate(() => (window as unknown as { __perfStart: () => void }).__perfStart());
  await action();
  const result = await page.evaluate(() => (window as unknown as { __perfStop: () => ProbeResult }).__perfStop());
  let profile = null;
  if (cdp) {
    profile = (await cdp.send("Profiler.stop")).profile as unknown as Parameters<typeof topFunctions>[0];
    await cdp.send("Profiler.disable");
  }
  const trace = cdp && browser ? traceBreakdown(await browser.stopTracing()) : null;
  return { result, profile, trace };
}

// ── scenarios ────────────────────────────────────────────────────────────────

type Scenario = { name: string; run: (page: Page) => Promise<void> };

const forceScenarios: Scenario[] = [
  {
    // First paint → layout settled. Measured from a fresh mount.
    name: "settle (4s)",
    run: async (page) => { await page.waitForTimeout(4000); },
  },
  {
    name: "pan (drag)",
    run: async (page) => {
      const b = await canvasBox(page);
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let i = 0; i <= 120; i++) {
        const a = (i / 120) * Math.PI * 4;
        await page.mouse.move(cx + Math.cos(a) * 180, cy + Math.sin(a) * 120);
      }
      await page.mouse.up();
    },
  },
  {
    name: "wheel zoom",
    run: async (page) => {
      const b = await canvasBox(page);
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      for (let i = 0; i < 24; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(16); }
      for (let i = 0; i < 24; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(16); }
    },
  },
  {
    name: "pan zoomed in",
    run: async (page) => {
      const b = await canvasBox(page);
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      await page.mouse.move(cx, cy);
      for (let i = 0; i < 18; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(16); }
      await page.mouse.down();
      for (let i = 0; i <= 120; i++) {
        const a = (i / 120) * Math.PI * 4;
        await page.mouse.move(cx + Math.cos(a) * 180, cy + Math.sin(a) * 120);
      }
      await page.mouse.up();
      for (let i = 0; i < 18; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(16); }
    },
  },
  {
    name: "hover sweep",
    run: async (page) => {
      const b = await canvasBox(page);
      for (let i = 0; i <= 150; i++) {
        await page.mouse.move(b.x + 40 + ((b.width - 80) * i) / 150, b.y + b.height / 2 + Math.sin(i / 8) * 80);
      }
    },
  },
  {
    name: "select / deselect",
    run: async (page) => {
      const ids = graph.nodes.slice(0, 6).map((n) => n.id);
      for (const id of [...ids, null, ...ids, null]) {
        await page.evaluate((nid) => {
          const s = (window as unknown as StoreWindow).__cairnStoreRef!.getState();
          (s.setSelectedGraphNode as (id: string | null) => void)(nid);
        }, id);
        await page.waitForTimeout(120);
      }
    },
  },
];

/** Screen point on the radial view's first ring (projects) at `angle` (rad, 0 = top). */
async function radialPoint(page: Page, ring: "branch" | "leaf", angle: number) {
  const b = await canvasBox(page);
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const maxR = Math.min(b.width, b.height) / 2 - 20; // spacing 1.2 / 1.2
  const innerR = 38, band = (maxR - innerR) / 2;
  const r = ring === "branch" ? innerR + band * 0.5 : innerR + band * 1.5;
  return { x: cx + Math.sin(angle) * r, y: cy - Math.cos(angle) * r, cx, cy };
}

const radialScenarios: Scenario[] = [
  {
    name: "hover sweep (leaves)",
    run: async (page) => {
      for (let i = 0; i <= 180; i++) {
        const p = await radialPoint(page, "leaf", (i / 180) * Math.PI * 2);
        await page.mouse.move(p.x, p.y);
      }
    },
  },
  {
    name: "drill in / out ×3",
    run: async (page) => {
      for (let i = 0; i < 3; i++) {
        const p = await radialPoint(page, "branch", 0.05 + i * 0.6);
        await page.mouse.click(p.x, p.y);
        await page.waitForTimeout(750);
        // The detail panel may have opened and moved the centre; re-measure.
        const hub = await radialPoint(page, "branch", 0);
        await page.mouse.click(hub.cx, hub.cy);
        await page.waitForTimeout(750);
      }
    },
  },
  {
    name: "select / deselect",
    run: async (page) => {
      const ids = graph.nodes.slice(0, 6).map((n) => n.id);
      for (const id of [...ids, null, ...ids, null]) {
        await page.evaluate((nid) => {
          const s = (window as unknown as StoreWindow).__cairnStoreRef!.getState();
          (s.setSelectedGraphNode as (id: string | null) => void)(nid);
        }, id);
        await page.waitForTimeout(120);
      }
    },
  },
];

// ── the run ──────────────────────────────────────────────────────────────────

test.describe.configure({ mode: "serial" });

test("knowledge graph canvas benchmark", async ({ browser }) => {
  test.setTimeout(15 * 60_000);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\n[graph-perf] cpu throttle ${CPU_THROTTLE}×, dpr ${DPR}`);
  console.log(`[graph-perf] graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges — ${source}`);
  const byType = new Map<string, number>();
  for (const e of graph.edges) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  console.log(`[graph-perf] edges by type: ${[...byType].map(([t, n]) => `${t} ${n}`).join(", ")}`);

  const rows: Row[] = [];
  const profiles: Record<string, ReturnType<typeof topFunctions>> = {};
  const traces: Record<string, ReturnType<typeof traceBreakdown>> = {};

  for (const v of VARIANTS) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: v.dpr ?? DPR,
    });
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    const cdp = v.profile ? session : null;
    try {
      if (CPU_THROTTLE > 1) await session.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
      await openGraph(page, v);
      const scenarios = v.layout === "force" ? forceScenarios : radialScenarios;
      for (const s of scenarios) {
        const { result, profile, trace } = await measure(page, cdp, () => s.run(page));
        const row = summarise(v.name, s.name, result);
        rows.push(row);
        console.log(`[graph-perf] ${v.name} · ${s.name}: ${row.fps} fps, p50 ${row["frame p50"]}ms, p95 ${row["frame p95"]}ms, rAF JS p95 ${row["rAF JS p95"]}ms`);
        if (profile) profiles[`${v.name} · ${s.name}`] = topFunctions(profile);
        if (trace) traces[`${v.name} · ${s.name}`] = trace;
        await page.waitForTimeout(300);
      }
    } finally {
      await context.close();
    }
  }

  console.log("\n=== Frame timing (ms; janky = frames over 25ms) ===");
  console.table(rows.map(({ calls: _calls, ...r }) => r));
  console.log("\n=== 2D canvas calls per frame ===");
  console.table(rows.map((r) => ({ variant: r.variant, scenario: r.scenario, calls: r.calls })));
  for (const [k, t] of Object.entries(traces)) {
    console.log(`\n=== Main-thread time by kind: ${k} ===`);
    console.table(t);
  }
  for (const [k, top] of Object.entries(profiles)) {
    console.log(`\n=== Hottest functions (self time): ${k} ===`);
    console.table(top);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join(OUT_DIR, `graph-perf-${stamp}.json`);
  fs.writeFileSync(out, JSON.stringify({
    graph: { nodes: graph.nodes.length, edges: graph.edges.length, source, edgesByType: Object.fromEntries(byType) },
    dpr: DPR,
    cpuThrottle: CPU_THROTTLE,
    rows,
    traces,
    profiles,
  }, null, 2));
  console.log(`\n[graph-perf] wrote ${out}`);
});
