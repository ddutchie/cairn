import { defineConfig, devices } from "@playwright/test";

/**
 * Cairn — Screenshot capture config (Route A: mocked IPC, headless Chromium)
 *
 * Fast, deterministic, no Electron + no live LLM. Renders the Next.js app with
 * the same window.electron mock as the smoke tests, but with a rich marketing
 * fixture (Cairn HQ) and a stable viewport for crisp 2× PNGs.
 *
 * Outputs land in ../cairn-site/assets/screenshots (light = default, dark in
 * dark/ subfolder for bichrome capture). Use CAIRN_SITE_DIR to override.
 *
 * Run:
 *   npm run screenshots              # light + dark (mocked)
 *   THEME=light npm run screenshots  # light only
 *   THEME=dark npm run screenshots   # dark only
 *   npm run screenshots:update       # same, with --update-snapshots semantics
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/screenshots.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    ...devices["Desktop Chrome"],
    headless: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2, // 2880×1800 crisp PNGs (site is displayed at 2×)
    screenshot: "off",
    trace: "off",
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
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
