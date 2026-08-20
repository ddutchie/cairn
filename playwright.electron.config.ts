import { defineConfig, devices } from "@playwright/test";

/**
 * Cairn — Playwright Electron QA configuration.
 *
 * Unlike the browser smoke config (`playwright.config.ts`, which runs the
 * Next.js dev server with a mocked `window.electron`), this config boots the
 * REAL Electron app (`_electron.launch`) and drives the Cordis loops (chat /
 * coding agent / heartbeat) end-to-end through the real IPC + preload bridge
 * + main process, against the live model bridge at CORDIS_TEST_BASE_URL.
 *
 * The Electron window loads the SAME Next.js dev server on :3000 in dev mode
 * (see electron/main.ts loadURL), so that webServer is shared here.
 *
 * Run:   CORDIS_LIVE=1 CORDIS_DUMMY_KEY=local npm run test:e2e:electron
 *
 * Every spec in tests/e2e/electron is gated behind CORDIS_LIVE=1 — without
 * the env it skips (no-op), so CI/`test:e2e` never break on the missing bridge.
 */
export default defineConfig({
  testDir: "./tests/e2e/electron",

  // Electron apps + live model calls are heavy and share the dev server; run
  // serially to avoid racing the single Next instance / model bridge.
  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env.CI,
  retries: 0, // live-model tests are flaky by nature; assert on plumbing not text

  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-electron-report" }],
  ],

  use: {
    ...devices["Desktop Chrome"],
    headless: false, // Electron needs a real display (headed locally / xvfb in CI)
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
    // DEMO_RECORD=1 captures a .webm of the app window for demo/product videos.
    // Output lands in ./electron-recordings/<test>.webm.
    ...(process.env.DEMO_RECORD === "1"
      ? { recordVideo: { dir: "electron-recordings", size: { width: 1440, height: 900 } } }
      : {}),
  },

  // Start the Next.js dev server (the Electron window loads it in dev mode).
  webServer: {
    command:
      "node scripts/generate-licenses.js && node scripts/generate-features.js && npx next dev --port 3000",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
