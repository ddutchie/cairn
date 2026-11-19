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
export default defineConfig({
  testDir: "./tests/perf",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
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
      "node scripts/generate-licenses.js && node scripts/generate-features.js && npx next dev --port 3000",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
