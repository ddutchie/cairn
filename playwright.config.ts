import { defineConfig, devices } from "@playwright/test";

/**
 * Cairn — Playwright E2E smoke test configuration.
 *
 * Tests run against the Next.js dev server (no Electron required).
 * The IPC layer is mocked via page.addInitScript() before React boots.
 *
 * Run:   npm run test:e2e
 * Debug: npx playwright test --ui
 */
export default defineConfig({
  testDir: "./tests/e2e",

  // Run tests serially — the dev server is shared, parallel runs can race on
  // React hydration timing. Increase if the suite grows and timing is stable.
  fullyParallel: false,
  workers: 1,

  // Fail fast in CI to surface issues quickly
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],

  use: {
    baseURL: "http://localhost:3000",
    // Headless Chromium — no GPU needed in CI
    ...devices["Desktop Chrome"],
    headless: true,
    // Capture traces on failure for debugging
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Reasonable timeout for a React app booting fresh
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },

  // Start the Next.js dev server automatically before the suite runs.
  // The server is reused across test files.
  webServer: {
    command: "npx next dev --port 3000",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // Suppress the Next.js compile output so test output stays readable
    stdout: "ignore",
    stderr: "pipe",
  },
});
