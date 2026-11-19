/**
 * Quick benchmark for the Architecture dependency graph (Agent → Architecture
 * → Graph): the codebase file-dependency canvas. Runs pan, wheel zoom, hover
 * and the initial settle on a synthetic code graph, at the display's full
 * resolution and at DPR 1, to show what drawing at reduced resolution during
 * movement is worth here.
 *
 * Run:  npm run bench:graph-arch
 *       FILES=600 EDGES=3000 npm run bench:graph-arch   (size of the code graph)
 *       CPU_THROTTLE / HEADED / DPR as in bench:graph-ui
 */

import { test, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import type { ProbeResult } from "./frame-probe";
import { OUT_DIR, pct, r1, bootApp, type StoreWindow } from "./harness";

const FILES = Number(process.env.FILES ?? 400);
const EDGES = Number(process.env.EDGES ?? 2000);
const DPR = Number(process.env.DPR ?? 2);
const CPU_THROTTLE = Number(process.env.CPU_THROTTLE ?? 1);
const CWD = "/tmp/cairn-demo";

/** Deterministic code graph: files in directories, mostly-local imports, a few hubs. */
function buildCodeGraph(files: number, edges: number) {
  let seed = 7;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const nodes = Array.from({ length: files }, (_, i) => ({
    id: `f${i}`,
    file_path: `${CWD}/src/mod${Math.floor(i / 20)}/file${i}.ts`,
    root_path: CWD,
    symbol_count: 1 + Math.floor(Math.pow(rand(), 2) * 40),
  }));
  const seen = new Set<string>();
  const out: { source: string; target: string; weight: number }[] = [];
  while (out.length < edges) {
    const s = Math.floor(rand() * files);
    const near = rand() < 0.7;
    const t = near ? Math.min(files - 1, Math.max(0, s + Math.floor((rand() - 0.5) * 40))) : Math.floor(Math.pow(rand(), 3) * files);
    const key = `${s}>${t}`;
    if (s === t || seen.has(key)) continue;
    seen.add(key);
    out.push({ source: `f${s}`, target: `f${t}`, weight: 1 + Math.floor(rand() * 5) });
  }
  return { folder: CWD, nodes, edges: out };
}

/** The dependency graph's canvas: the one beside the "Fit to view" button (the
 *  largest canvas on the page can be the terminal's). */
async function canvasBox(page: Page) {
  const box = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Fit to view"]');
    const c = btn?.parentElement?.parentElement?.querySelector("canvas") ?? btn?.closest("div.relative")?.querySelector("canvas");
    const r = c?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  });
  if (!box) throw new Error("architecture graph canvas not found");
  return box;
}

const codeGraph = buildCodeGraph(FILES, EDGES);
const overview = {
  folder: CWD, roots: [CWD], fileCount: FILES, totalSymbols: FILES * 10, totalRelations: EDGES, lastIndexedAt: null, kinds: [],
  files: codeGraph.nodes.map((n) => ({ id: n.id, file_path: n.file_path, root_path: CWD, indexed_at: "", symbol_count: n.symbol_count, relation_count: 0 })),
};

async function openArchitecture(page: Page) {
  // Patch the codebase calls after the mock installs window.electron.
  const extraInit = `(() => { const g = ${JSON.stringify(codeGraph)}, o = ${JSON.stringify(overview)};
    const patch = () => { const a = window.electron && window.electron.agent; if (!a) return false;
      a.codebaseOverview = () => Promise.resolve(o); a.codebaseGraph = () => Promise.resolve(g); return true; };
    if (!patch()) { const t = setInterval(() => { if (patch()) clearInterval(t); }, 5); } })();`;
  await bootApp(page, { nodes: [], edges: [] }, { extraInit });
  await page.evaluate(() => ((window as unknown as StoreWindow).__cairnStoreRef!.getState().setView as (v: string) => void)("agent"));
  await page.getByRole("button", { name: "Architecture", exact: true }).click();
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("canvas").length > 0, null, { timeout: 20_000 });
  await page.waitForTimeout(300);
}

interface Row { variant: string; scenario: string; draws: number; fps: number; "frame p95": number; "frame max": number; "janky %": number; "long task ms": number }

async function measure(page: Page, variant: string, scenario: string, run: () => Promise<void>): Promise<Row> {
  await page.evaluate(() => (window as unknown as { __perfStart: () => void }).__perfStart());
  await run();
  const r = await page.evaluate(() => (window as unknown as { __perfStop: () => ProbeResult }).__perfStop());
  const iv = r.intervals;
  const row: Row = {
    variant, scenario,
    draws: r.calls.clearRect ?? 0,
    fps: r1(r.frames / (r.durationMs / 1000)),
    "frame p95": r1(pct(iv, 95)),
    "frame max": r1(Math.max(0, ...iv)),
    "janky %": iv.length ? Math.round((iv.filter((x) => x > 25).length / iv.length) * 100) : 0,
    "long task ms": Math.round(r.longTaskMs),
  };
  console.log(`[graph-arch] ${variant} · ${scenario}: ${row.draws} draws, ${row.fps} fps, p95 ${row["frame p95"]}ms, janky ${row["janky %"]}%`);
  return row;
}

test("architecture graph benchmark", async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\n[graph-arch] ${FILES} files, ${EDGES} edges; cpu ${CPU_THROTTLE}×`);
  const rows: Row[] = [];
  for (const [variant, dpr] of [[`dpr ${DPR}`, DPR], ["dpr 1", 1]] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    if (CPU_THROTTLE > 1) await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
    try {
      await openArchitecture(page);
      const canvas = () => canvasBox(page);
      rows.push(await measure(page, variant, "settle (3s)", () => page.waitForTimeout(3000)));
      rows.push(await measure(page, variant, "pan (drag)", async () => {
        const b = await canvas(); const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
        await page.mouse.move(cx, cy); await page.mouse.down();
        for (let i = 0; i <= 120; i++) { const a = (i / 120) * Math.PI * 4; await page.mouse.move(cx + Math.cos(a) * 180, cy + Math.sin(a) * 120); }
        await page.mouse.up();
      }));
      rows.push(await measure(page, variant, "wheel zoom", async () => {
        const b = await canvas(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
        for (let i = 0; i < 24; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(16); }
        for (let i = 0; i < 24; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(16); }
      }));
      rows.push(await measure(page, variant, "hover sweep", async () => {
        const b = await canvas();
        for (let i = 0; i <= 150; i++) await page.mouse.move(b.x + 40 + ((b.width - 80) * i) / 150, b.y + b.height / 2 + Math.sin(i / 8) * 80);
      }));
    } finally {
      await context.close();
    }
  }
  console.log("\n=== Architecture graph ===");
  console.table(rows);
  const out = path.join(OUT_DIR, `graph-arch-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(out, JSON.stringify({ files: FILES, edges: EDGES, dpr: DPR, cpuThrottle: CPU_THROTTLE, rows }, null, 2));
  console.log(`[graph-arch] wrote ${out}`);
});
