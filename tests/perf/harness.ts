/**
 * Shared setup for the graph benchmarks: boot the mocked renderer with the
 * large graph and the frame probe, open the Knowledge Graph, find its canvas.
 */

import type { Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { buildScreenshotMock, PROJ_A } from "../fixtures/screenshot-fixture";
import type { BenchGraph } from "./large-graph";
import { frameProbeScript, type PerfFlags } from "./frame-probe";

export type StoreWindow = { __cairnStoreRef?: { getState: () => Record<string, unknown> } };

/** Every What's New id, so the modal never opens over the canvas. */
const FEATURE_IDS: string[] = (() => {
  try {
    const file = path.resolve(__dirname, "..", "..", "src", "generated", "new-features.json");
    return (JSON.parse(fs.readFileSync(file, "utf8")).registry as { id: string }[]).map((f) => f.id);
  } catch {
    return [];
  }
})();

export const OUT_DIR = path.resolve(__dirname, "..", "..", "test-results", "graph-perf");

export const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const r1 = (n: number) => Math.round(n * 10) / 10;

/** Boot the app with `graph` and the frame probe, overlays dismissed, sidebar collapsed. */
export async function bootApp(
  page: Page,
  graph: BenchGraph,
  opts: { flags?: PerfFlags; storage?: Record<string, string>; extraInit?: string } = {},
) {
  await page.addInitScript({ content: buildScreenshotMock({ graph }) });
  await page.addInitScript({ content: frameProbeScript(opts.flags ?? {}) });
  await page.addInitScript({
    content: `try { localStorage.setItem("cairn:v1:seenFeatures", ${JSON.stringify(JSON.stringify(FEATURE_IDS))}); localStorage.setItem("kg-spacing", "1.2");
      ${Object.entries(opts.storage ?? {}).map(([k, val]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(val)});`).join("\n")}
    } catch {}`,
  });
  // Scripts that run after the IPC mock is installed (e.g. patching one call).
  if (opts.extraInit) await page.addInitScript({ content: opts.extraInit });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!(window as unknown as StoreWindow).__cairnStoreRef, null, { timeout: 30_000 });
  await page.waitForTimeout(500);
  // Hide the tutorial / What's New overlays so they don't eat clicks.
  await page.addStyleTag({ content: `.fixed.inset-0.z-\\[9999\\], [role="dialog"], nextjs-portal { display: none !important; }` });
  await page.evaluate(({ projId, ids }) => {
    const s = (window as unknown as StoreWindow).__cairnStoreRef!.getState();
    try { (s.setTutorialActive as (v: boolean) => void)?.(false); } catch {}
    for (const id of ids) try { (s.markFeatureAsSeen as (id: string) => void)?.(id); } catch {}
    if (s.chatOpen) (s.toggleChat as () => void)();
    if (!s.sidebarCollapsed) (s.toggleSidebar as () => void)();
    (s.setActiveProject as (id: string) => void)(projId);
  }, { projId: PROJ_A, ids: FEATURE_IDS });
}

/** Switch to the Knowledge Graph view in `layout`. Doesn't wait. */
export async function showGraph(page: Page, layout: "force" | "radial") {
  await page.evaluate((l) => {
    const s = (window as unknown as StoreWindow).__cairnStoreRef!.getState();
    (s.setGraphLayout as (l: string) => void)(l);
    (s.setView as (v: string) => void)("graph");
  }, layout);
}

/** Wait until the graph data has reached the store. */
export async function waitForGraphData(page: Page) {
  await page.waitForFunction(() => {
    const s = (window as unknown as StoreWindow).__cairnStoreRef!.getState();
    return ((s.graphData as { nodes: unknown[] })?.nodes?.length ?? 0) > 0;
  }, null, { timeout: 15_000 });
}

/** The graph canvas (the largest canvas on screen). */
export async function canvasBox(page: Page) {
  const box = await page.evaluate(() => {
    let best: DOMRect | null = null;
    for (const c of document.querySelectorAll("canvas")) {
      const r = c.getBoundingClientRect();
      if (!best || r.width * r.height > best.width * best.height) best = r;
    }
    return best ? { x: best.x, y: best.y, width: best.width, height: best.height } : null;
  });
  if (!box) throw new Error("graph canvas not found");
  return box;
}

/** Throw if something (a modal, an overlay) covers the canvas centre. */
export async function assertCanvasReachable(page: Page) {
  const b = await canvasBox(page);
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? null, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
  if (hit !== "CANVAS") throw new Error(`something covers the graph canvas (hit ${hit}); pointer scenarios would not reach it`);
}
