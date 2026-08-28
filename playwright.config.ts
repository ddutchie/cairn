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
  // Exclude the Electron-launched suite — it uses _electron.launch which the
  // Chromium/browser config here can't drive. That suite has its own config
  // at playwright.electron.config.ts and its own npm script
  // (`npm run test:e2e:electron`). Without this ignore, the recursive test
  // walker collects tests/e2e/electron/*.test.ts under this config and
  // schedules them for browser execution, where they silently no-op via
  // test.skip(!LIVE) — the wrong test runner, hiding the real coverage gap.
  testIgnore: "**/electron/**",

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
    // Generate BOTH baked-in JSON artifacts before starting the dev server:
    // licenses.json AND new-features.json are git-ignored (built at build time),
    // and the What's New smoke tests import `@/generated/new-features.json`. If
    // it's missing the Next build fails to resolve the import and every test
    // fails — this is what broke the release pipeline's e2e job, which runs
    // `npm run test:e2e` without going through the `dev` script that normally
    // generates these. Generating them here keeps `test:e2e` self-sufficient.
    command:
      "node scripts/generate-licenses.js && node scripts/generate-features.js && npx next dev --port 3000",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // Suppress the Next.js compile output so test output stays readable
    stdout: "ignore",
    stderr: "pipe",
  },
});
