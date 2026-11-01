import { defineConfig, devices } from "@playwright/test";

/**
 * Cairn — Design audit capture (mocked IPC, headless Chromium)
 *
 * Captures every view, every Settings section/subtab, the chat drawer and the
 * transient surfaces (search, notifications, menus) in light + dark, so a UI
 * consistency pass can be reviewed and re-run before/after. Unlike the
 * marketing screenshots, dialogs are left visible.
 *
 * Run:  npm run screenshots:audit           (light + dark → design-audit/screens)
 *       THEME=dark npm run screenshots:audit
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/design-audit.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    ...devices["Desktop Chrome"],
    headless: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    screenshot: "off",
    trace: "off",
    video: "off",
    actionTimeout: 10_000,
    navigationTimeout: 45_000,
  },
  webServer: {
    command:
      "node scripts/generate-licenses.js && node scripts/generate-features.js && npx next dev --port 3000",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 90_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
