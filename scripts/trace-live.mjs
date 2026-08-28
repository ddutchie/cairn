import { chromium } from "@playwright/test";

async function traceLiveApp() {
  console.log("==================================================");
  console.log("    Tracing Performance on Running Live Server    ");
  console.log("==================================================");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleLogs = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("[chat]") || text.includes("[hydrate]") || text.includes("[mcp]") || text.includes("error") || text.includes("warn")) {
      consoleLogs.push({ type: msg.type(), text });
    }
  });

  console.log("[1/4] Navigating to http://localhost:3000...");
  await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });

  // Install performance observers
  await page.evaluate(() => {
    window.__perfData = {
      longTasks: [],
      frameDelays: [],
      lastRaf: performance.now(),
      rafRunning: true,
    };

    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__perfData.longTasks.push({
            name: entry.name,
            startTime: Math.round(entry.startTime),
            duration: Math.round(entry.duration),
          });
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch (e) {
      console.warn("PerformanceObserver error:", e);
    }

    function onRaf(now) {
      const delta = now - window.__perfData.lastRaf;
      window.__perfData.lastRaf = now;
      if (delta > 50) {
        window.__perfData.frameDelays.push({
          time: Math.round(now),
          delay: Math.round(delta),
        });
      }
      if (window.__perfData.rafRunning) requestAnimationFrame(onRaf);
    }
    requestAnimationFrame(onRaf);
  });

  console.log("[2/4] Waiting 5s for initial layout & hydration stabilization...");
  await page.waitForTimeout(5000);

  console.log("[3/4] Recording 15 seconds of idle background activity...");
  const idleStart = Date.now();
  await page.waitForTimeout(15000);

  const idleStats = await page.evaluate(() => ({
    longTasks: window.__perfData.longTasks.filter((t) => t.startTime > 5000),
    frameDelays: window.__perfData.frameDelays.filter((f) => f.time > 5000),
  }));

  console.log(`\n--- 15s Idle Stability Results ---`);
  console.log(`Long Tasks (>50ms) during idle: ${idleStats.longTasks.length}`);
  for (const lt of idleStats.longTasks) {
    console.log(`  • Long task at ${lt.startTime}ms: duration=${lt.duration}ms`);
  }
  console.log(`Frame drops (>50ms gap) during idle: ${idleStats.frameDelays.length}`);
  for (const fd of idleStats.frameDelays.slice(0, 5)) {
    console.log(`  • Frame drop at ${fd.time}ms: delta=${fd.delay}ms`);
  }

  console.log("\n[4/4] Exercising UI interactions and view switches...");
  const views = ["overview", "notes", "board", "flow", "graph", "insights", "settings"];
  const viewResults = [];

  for (const view of views) {
    const t0 = Date.now();
    await page.evaluate((v) => {
      const store = window.__cairnStoreRef?.getState?.();
      if (store?.setView) store.setView(v);
    }, view);
    await page.waitForTimeout(700);
    viewResults.push({ view, timeMs: Date.now() - t0 });
  }

  console.log(`\n--- View Navigation Latencies ---`);
  for (const vr of viewResults) {
    console.log(`  • Navigated to '${vr.view}': ${vr.timeMs}ms`);
  }

  const allStats = await page.evaluate(() => {
    window.__perfData.rafRunning = false;
    return {
      allLongTasks: window.__perfData.longTasks,
      allFrameDelays: window.__perfData.frameDelays,
    };
  });

  console.log("\n==================================================");
  console.log("            PERFORMANCE TRACE SUMMARY             ");
  console.log("==================================================");
  console.log(`Total Long Tasks (>50ms): ${allStats.allLongTasks.length}`);
  console.log(`Total Frame Drops (>50ms): ${allStats.allFrameDelays.length}`);
  console.log(`Background Idle Spikes: ${idleStats.longTasks.length === 0 ? "NONE (0ms blocked)" : idleStats.longTasks.length + " events"}`);
  console.log(`Captured Console Notices: ${consoleLogs.length}`);
  for (const cl of consoleLogs.slice(0, 5)) {
    console.log(`  [${cl.type}] ${cl.text.slice(0, 100)}`);
  }
  console.log("==================================================\n");

  await browser.close();
}

traceLiveApp().catch((err) => {
  console.error("Live trace error:", err);
  process.exit(1);
});
