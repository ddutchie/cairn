import { chromium } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACE_FILE = path.join(__dirname, "..", "cdp-devtools-trace.json");

async function captureDevToolsTrace() {
  console.log("=========================================================");
  console.log("  Connecting Chrome DevTools Protocol (CDP) Tracing...   ");
  console.log("=========================================================");

  const browser = await chromium.launch({
    headless: true,
    args: ["--enable-benchmarking", "--enable-net-benchmarking"],
  });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const cdp = await context.newCDPSession(page);

  // Enable Performance domain
  await cdp.send("Performance.enable");

  const traceEvents = [];
  cdp.on("Tracing.dataCollected", (event) => {
    traceEvents.push(...event.value);
  });

  console.log("[1/4] Starting Chrome DevTools Timeline & CPU Trace...");
  await cdp.send("Tracing.start", {
    traceConfig: {
      recordMode: "recordUntilFull",
      includedCategories: [
        "-*",
        "devtools.timeline",
        "v8.execute",
        "disabled-by-default-devtools.timeline",
        "disabled-by-default-devtools.timeline.frame",
        "disabled-by-default-devtools.timeline.stack",
        "disabled-by-default-v8.cpu_profiler",
        "toplevel",
        "blink.user_timing",
        "loading",
      ],
      enableSampling: true,
      enableSystrace: false,
    },
  });

  console.log("[2/4] Navigating to http://localhost:3000 and capturing load & LCP...");
  const tNav = Date.now();
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  console.log(`      Page network idle reached in ${Date.now() - tNav}ms`);

  console.log("[3/4] Recording 10s of background timeline activity & view switching...");
  await page.waitForTimeout(5000);

  // Switch views
  const views = ["notes", "board", "flow", "graph", "insights", "settings", "overview"];
  for (const v of views) {
    await page.evaluate((viewName) => {
      window.__cairnStoreRef?.getState?.()?.setView?.(viewName);
    }, v);
    await page.waitForTimeout(600);
  }

  console.log("[4/4] Stopping DevTools Trace and gathering events...");
  const tracingCompletePromise = new Promise((resolve) => {
    cdp.on("Tracing.tracingComplete", resolve);
  });

  await cdp.send("Tracing.end");
  await tracingCompletePromise;

  // Save the full trace to JSON (Chrome DevTools compatible)
  fs.writeFileSync(TRACE_FILE, JSON.stringify({ traceEvents }, null, 2), "utf-8");
  console.log(`      Saved full Chrome DevTools trace to: ${TRACE_FILE} (${(fs.statSync(TRACE_FILE).size / 1024 / 1024).toFixed(2)} MB)`);

  // Analyze trace events
  console.log("\n=========================================================");
  console.log("            DEVTOOLS TRACE ANALYSIS REPORT               ");
  console.log("=========================================================");

  // Find LCP
  const lcpCandidates = traceEvents.filter((e) => e.name === "largestContentfulPaint::Candidate" || e.name === "LargestContentfulPaint");
  console.log(`LCP Events Found: ${lcpCandidates.length}`);
  if (lcpCandidates.length > 0) {
    const lastLcp = lcpCandidates[lcpCandidates.length - 1];
    const lcpMs = (lastLcp.ts - traceEvents[0].ts) / 1000;
    console.log(`  • LCP Timestamp: ${lcpMs.toFixed(2)} ms`);
    if (lastLcp.args?.data?.size) {
      console.log(`  • LCP Element Size: ${lastLcp.args.data.size}px`);
    }
  }

  // Find Long Tasks & Long Function Calls (> 50ms)
  const longTasks = traceEvents.filter(
    (e) => (e.name === "RunTask" || e.name === "FunctionCall" || e.name === "EvaluateScript" || e.name === "Layout") && e.dur && e.dur > 50000
  );

  console.log(`\nLong Tasks / Operations (>50ms): ${longTasks.length}`);
  for (const lt of longTasks) {
    const durMs = (lt.dur / 1000).toFixed(2);
    const timeMs = ((lt.ts - traceEvents[0].ts) / 1000).toFixed(2);
    const fnName = lt.args?.data?.functionName || lt.args?.data?.scriptName || lt.name;
    const url = lt.args?.data?.url || lt.args?.data?.scriptId || "";
    console.log(`  • [${lt.name}] Duration: ${durMs}ms at ${timeMs}ms — ${fnName} ${url ? `(${url})` : ""}`);
  }

  // Find render / commit / layout events (> 30ms)
  const longRenders = traceEvents.filter(
    (e) => (e.name === "Commit" || e.name === "UpdateLayoutTree" || e.name === "Paint") && e.dur && e.dur > 30000
  );
  console.log(`\nLong Render / Style / Layout Events (>30ms): ${longRenders.length}`);
  for (const r of longRenders) {
    const durMs = (r.dur / 1000).toFixed(2);
    const timeMs = ((r.ts - traceEvents[0].ts) / 1000).toFixed(2);
    console.log(`  • [${r.name}] Duration: ${durMs}ms at ${timeMs}ms`);
  }

  console.log("=========================================================\n");

  await browser.close();
}

captureDevToolsTrace().catch((err) => {
  console.error("CDP trace failed:", err);
  process.exit(1);
});
