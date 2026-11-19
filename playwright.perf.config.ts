import { defineConfig, devices } from "@playwright/test";

/**
 * Cairn — graph canvas benchmark (tests/perf). Mocked IPC against the Next dev
 * server, like the screenshot config. Not part of `test:e2e`.
 *
 * Run: npm run bench:graph-ui   (see tests/perf/graph-perf.spec.ts for options)
 *
 * Headless Chromium rasterises in software, so absolute frame times differ
 * from the desktop app; compare variants against each other. HEADED=1 runs a
 * visible window with the GPU.
 */
/** A port of its own, so a dev server from another checkout is never reused. */
const PORT = Number(process.env.BENCH_PORT ?? 3217);

export default defineConfig({
  testDir: "./tests/perf",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices["Desktop Chrome"],
    headless: !process.env.HEADED,
    screenshot: "off",
    trace: "off",
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
  },
  webServer: {
    command:
      `node scripts/generate-licenses.js && node scripts/generate-features.js && npx next dev --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    // Never attach to a server from another checkout: timings would be
    // attributed to the wrong build. Opt in with REUSE_SERVER=1.
    reuseExistingServer: !!process.env.REUSE_SERVER,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
