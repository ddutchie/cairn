/**
 * Quick benchmark for the Force layout settling — the slow part on a large
 * graph. Times how long each layout takes to settle, how soon the graph first
 * appears, and how smooth the frames are in between, for:
 *
 *   - cold open: first time the Knowledge Graph opens in the session
 *   - reopen: leaving the view and coming back (remembered layout)
 *   - focus in / out: "Show neighbourhood" on a node, then Esc back
 *
 * Run:  npm run bench:graph-settle
 *       (same GRAPH_JSON / HEADED / DPR / CPU_THROTTLE options as bench:graph-ui)
 *       NO_DASH=1 npm run bench:graph-settle   (dashed edges drawn solid)
 */

import { test, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { loadBenchGraph } from "./large-graph";
import type { ProbeResult } from "./frame-probe";
import { OUT_DIR, pct, r1, bootApp, showGraph, waitForGraphData, type StoreWindow } from "./harness";

const { graph, source } = loadBenchGraph();
const DPR = Number(process.env.DPR ?? 2);
const CPU_THROTTLE = Number(process.env.CPU_THROTTLE ?? 1);
const NO_DASH = !!process.env.NO_DASH;
/** Focus targets: the best-connected notes, so each neighbourhood is sizeable. */
const FOCUS_IDS = (() => {
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  return graph.nodes
    .filter((n) => n.type === "note")
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, 3)
    .map((n) => n.id);
})();

interface Row {
  scenario: string;
  "settled ms": number;
  "first paint ms": number | null;
  draws: number;
  fps: number;
  "frame p95": number;
  "frame max": number;
  "janky %": number;
  "long task ms": number;
}

/** Mark the current graph canvas as old, so the wait below only accepts the one mounted next. */
async function markOld(page: Page) {
  await page.evaluate(() => {
    for (const c of document.querySelectorAll("canvas[data-layout]")) (c as HTMLElement).dataset.benchOld = "1";
  });
}

/** Resolve with ms since `t0` (page clock) when a new canvas reports a settled layout. */
async function waitSettled(page: Page, t0: number, timeoutMs = 60_000): Promise<number> {
  return page.evaluate(({ t0, timeoutMs }) => new Promise<number>((resolve, reject) => {
    const done = () => {
      const c = [...document.querySelectorAll<HTMLCanvasElement>("canvas[data-layout]")]
        .find((el) => !el.dataset.benchOld && el.dataset.layout === "settled");
      return c ? performance.now() - t0 : null;
    };
    // Settled can be reported before the frame that shows it is painted; let
    // two frames pass so the final paint is part of the measurement.
    const finish = (t: number) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(t)));
    const now = done();
    if (now != null) return finish(now);
    const obs = new MutationObserver(() => {
      const t = done();
      if (t != null) { obs.disconnect(); clearTimeout(timer); finish(t); }
    });
    obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-layout"] });
    const timer = setTimeout(() => { obs.disconnect(); reject(new Error("layout did not settle")); }, timeoutMs);
  }), { t0, timeoutMs });
}

/** Run `action`, wait for the new layout to settle, and summarise the frames in between. */
async function timeSettle(page: Page, scenario: string, action: () => Promise<void>): Promise<Row> {
  await markOld(page);
  const t0 = await page.evaluate(() => {
    (window as unknown as { __perfStart: () => void }).__perfStart();
    return performance.now();
  });
  await action();
  const settled = await waitSettled(page, t0);
  const r = await page.evaluate(() => (window as unknown as { __perfStop: () => ProbeResult }).__perfStop());
  const iv = r.intervals;
  return {
    scenario,
    "settled ms": Math.round(settled),
    "first paint ms": r.firstFillMs == null ? null : Math.round(r.firstFillMs),
    draws: r.calls.clearRect ?? 0,
    fps: r1(r.frames / (r.durationMs / 1000)),
    "frame p95": r1(pct(iv, 95)),
    "frame max": r1(Math.max(0, ...iv)),
    "janky %": iv.length ? Math.round((iv.filter((x) => x > 25).length / iv.length) * 100) : 0,
    "long task ms": Math.round(r.longTaskMs),
  };
}

test("knowledge graph settle benchmark", async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\n[graph-settle] ${graph.nodes.length} nodes, ${graph.edges.length} edges — ${source}; dpr ${DPR}, cpu ${CPU_THROTTLE}×${NO_DASH ? ", no dashes" : ""}`);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: DPR });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  if (CPU_THROTTLE > 1) await session.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  const rows: Row[] = [];
  const log = (row: Row) => {
    rows.push(row);
    console.log(`[graph-settle] ${row.scenario}: settled ${row["settled ms"]}ms, first paint ${row["first paint ms"]}ms, ${row.draws} draws, ${row.fps} fps, p95 ${row["frame p95"]}ms`);
  };

  try {
    await bootApp(page, graph, { flags: NO_DASH ? { noDash: true } : {} });
    log(await timeSettle(page, "cold open", async () => {
      await showGraph(page, "force");
      await waitForGraphData(page);
    }));

    const setView = (v: string) => page.evaluate((view) => {
      ((window as unknown as StoreWindow).__cairnStoreRef!.getState().setView as (v: string) => void)(view);
    }, v);
    await setView("overview");
    await page.waitForTimeout(500);
    log(await timeSettle(page, "reopen", () => setView("graph")));

    for (const [i, id] of FOCUS_IDS.entries()) {
      await page.evaluate((nid) => {
        ((window as unknown as StoreWindow).__cairnStoreRef!.getState().setSelectedGraphNode as (id: string) => void)(nid);
      }, id);
      const button = page.getByRole("button", { name: "Show neighbourhood" });
      await button.waitFor({ timeout: 10_000 });
      log(await timeSettle(page, `focus in #${i + 1}`, () => button.click()));
      await page.waitForTimeout(200);
      log(await timeSettle(page, `focus out #${i + 1}`, () => page.keyboard.press("Escape")));
      await page.waitForTimeout(200);
    }
  } finally {
    await context.close();
  }

  console.log("\n=== Layout settle (settled = until the layout stops; janky = frames over 25ms) ===");
  console.table(rows);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join(OUT_DIR, `graph-settle-${stamp}.json`);
  fs.writeFileSync(out, JSON.stringify({
    graph: { nodes: graph.nodes.length, edges: graph.edges.length, source },
    dpr: DPR, cpuThrottle: CPU_THROTTLE, noDash: NO_DASH, rows,
  }, null, 2));
  console.log(`[graph-settle] wrote ${out}`);
});
