/**
 * Cairn — Screenshot capture (Route A: mocked Chromium, deterministic)
 *
 * Renders every view with a rich fixture and saves full-window PNGs directly
 * into ../cairn-site/assets/screenshots/. Captures both light + dark by
 * flipping the store theme + document data-theme between passes.
 *
 * The "Next" buttons (AppTutorial Next/Finish, What's New Next Feature/Skip All)
 * are hidden for screenshots via a injected stylesheet + JS hide, so they never
 * appear in the marketing images. The tutorial and feature modal themselves are
 * suppressed by seeding seenFeatures + disabling tutorialActive.
 *
 * Run:  npm run screenshots              (light + dark)
 *       THEME=light npm run screenshots  (light only)
 *       THEME=dark  npm run screenshots  (dark only)
 *       CAIRN_SITE_DIR=/path npm run screenshots
 */

import { test, expect, type Page } from "@playwright/test";
import { buildScreenshotMock, PROJ_A } from "../fixtures/screenshot-fixture";
import * as path from "path";
import * as fs from "fs";

function resolveDefaultSiteDir(): string {
  // Sibling checkout (../cairn-site) — generic relative path, not a hardcoded user dir.
  // If the sibling isn't present (other contributors / CI), fall back to a local
  // output folder so `npm run screenshots` still works without CAIRN_SITE_DIR.
  const candidate = path.resolve(__dirname, "..", "..", "..", "cairn-site", "assets", "screenshots");
  const siblingRoot = path.resolve(__dirname, "..", "..", "..", "cairn-site");
  if (process.env.CAIRN_SITE_DIR) return path.resolve(process.env.CAIRN_SITE_DIR);
  if (fs.existsSync(siblingRoot)) return candidate;
  // No sibling — write next to the repo and tell the user where to find it.
  const fallback = path.resolve(__dirname, "..", "..", "screenshots");
  console.log(`[screenshots] No sibling ../cairn-site found and CAIRN_SITE_DIR not set — writing to ${fallback}`);
  console.log(`[screenshots] To update the real site, run: CAIRN_SITE_DIR=/path/to/cairn-site npm run screenshots`);
  return fallback;
}
const SITE_DIR = resolveDefaultSiteDir();

type Theme = "light" | "dark";
const THEMES: Theme[] =
  process.env.THEME === "light"
    ? ["light"]
    : process.env.THEME === "dark"
      ? ["dark"]
      : ["light", "dark"];

// Views to capture — each entry defines the output filename, the app view,
// and any view-specific settling (extra waits / sub-state). The filenames
// match index.html + docs/*.html references so the site updates automatically.
type Shot = {
  file: string; // relative to SITE_DIR (light goes to root/<file>, dark to dark/<file>)
  view: string; // AppUIState["activeView"]
  setup?: (page: Page) => Promise<void>;
  // Optional pre-capture hook: open modals, set tabs, etc.
};

const SHOTS: Shot[] = [
  { file: "hero.png", view: "overview" }, // hero uses the overview/landing; captured as full window
  { file: "notes.png", view: "notes" },
  { file: "kanban.png", view: "board" },
  { file: "docs/calendar-month.png", view: "calendar" },
  { file: "idea-flow.png", view: "flow" },
  { file: "knowledge-graph.png", view: "graph" },
  { file: "insights.png", view: "insights", setup: async (p) => {
    // Let ridgeline/beeswarm settle — InsightsView mounts D3 canvases on first paint
    await p.waitForTimeout(800);
  }},
  { file: "agent.png", view: "agent" },
  { file: "automations.png", view: "automations" },
  { file: "usage.png", view: "usage" },
  // Chat is a drawer rather than a view — open it over board for the ai-chat shot
  { file: "ai-chat.png", view: "board", setup: async (p) => {
    await p.evaluate(() => (window as any).__cairnStoreRef?.getState()?.toggleChat?.());
    await p.waitForTimeout(500);
  }},
  // Dashboard/PRD are notes in the real app — boards already show rich cards for those shots
  { file: "dashboard.png", view: "board" },
  { file: "prd-generator.png", view: "board" },
  { file: "mobile.png", view: "board" }, // mobile is responsive — board as placeholder until dedicated mobile viewport
];

// Hides the "Next" affordances and any transient modals before capture.
// Covers:
//  - AppTutorial Next/Finish + backdrop (z-[9999] overlay)
//  - What's New Next Feature / Skip All / Done buttons + its ModalShell
//  - Any button whose visible text is exactly "Next", "Next Feature", "Skip All", "Done" inside a dialog
//  - Dev-only ShellSwitcher / ShellPreviewBanner (A·Rail / B·Desk etc.) — never in marketing shots
//  - Forces smallest font scale (1) for deterministic, compact screenshots
const HIDE_NEXT_SCRIPT = `
(() => {
  // 0) Force smallest font + keep correct header (Unified Rail = A) while hiding the dev switcher
  try {
    const s = window.__cairnStoreRef?.getState?.();
    if (s) {
      try { s.setFontScale(1); } catch {}
      try { s.setShellVariant("A"); } catch {}
      try { s.setTutorialActive(false); } catch {}
      const ids = ["v2.7.0-responses-api","v2.7.4-automation-mini-app","v2.7.5-note-fonts","v2.7.5-chat-themes","v2.7.7-cordis-coding-engine"];
      for (const id of ids) try { s.markFeatureAsSeen(id); } catch {}
    }
    try { localStorage.setItem("cairn:v1:fontScale", "1"); } catch {}
    try { localStorage.setItem("cairn:v1:shellVariant", JSON.stringify("A")); } catch {}
    try { document.documentElement.style.setProperty("--font-scale", "1"); } catch {}
    try { localStorage.setItem("cairn:v1:seenFeatures", JSON.stringify(["v2.7.0-responses-api","v2.7.4-automation-mini-app","v2.7.5-note-fonts","v2.7.5-chat-themes","v2.7.7-cordis-coding-engine"])); } catch {}
  } catch {}

  // 1) Inject a persistent stylesheet that hides the tutorial overlay + Next chrome + dev ShellSwitcher + Next.js dev indicator + bottom-right debug badge
  const id = "cairn-screenshot-hide-next";
  if (!document.getElementById(id)) {
    const style = document.createElement("style");
    style.id = id;
    style.textContent = \`
      /* Tutorial overlay + What's New modal — never in screenshots */
      .fixed.inset-0.z-\\\\[9999\\\\] { display: none !important; }
      [role="dialog"] { display: none !important; }
      .fixed.inset-0.bg-black\\/50, .fixed.inset-0.backdrop-blur-sm { display: none !important; }
      /* Dev-only ShellSwitcher (Topbar + ShellPreviewBanner) */
      [role="tablist"][aria-label="Shell preview"] { display: none !important; }
      /* Next.js dev overlay + error toasts / bottom-right debug icon */
      nextjs-portal, #__nextjs_original-stack-frame, [data-nextjs-dialog], [data-nextjs-dialog-overlay], #__next-build-watcher { display: none !important; }
      .fixed.bottom-4.right-4 { display: none !important; }
    \`;
    document.head.appendChild(style);
  }

  // 2) Hide any button whose label is Next / Next Feature / Finish / Skip All / Done
  const NEXT_RE = /^(Next|Next Feature|Finish|Skip All|Done)$/;
  for (const b of document.querySelectorAll("button")) {
    const t = (b.textContent ?? "").trim();
    if (NEXT_RE.test(t)) {
      const inDialog = !!b.closest('[role="dialog"]');
      const inTutorial = !!b.closest(".fixed.inset-0");
      if (inDialog || inTutorial || t === "Next" || t === "Next Feature") {
        b.style.display = "none";
      }
    }
  }

  // 3) Hide ShellPreviewBanner ("Shell preview" text) and any remaining ShellSwitcher by text
  for (const el of document.querySelectorAll("div, header")) {
    const txt = (el.textContent || "");
    if (txt.includes("Shell preview") && txt.includes("Unified Rail")) {
      el.style.display = "none";
    }
  }
  // 4) Hide bottom-right dev/debug icon (fixed corner badge) — Next.js or plugin overlay
  document.querySelectorAll('.fixed.bottom-4.right-4').forEach(el => el.style.display = 'none');
  document.querySelectorAll('nextjs-portal, [id*="nextjs"]').forEach(el => el.style.display = 'none');
})();
`;

async function prepareForScreenshots(page: Page): Promise<void> {
  await page.evaluate((script) => {
    // eslint-disable-next-line no-new-func
    new Function(script)();
  }, HIDE_NEXT_SCRIPT);
  // Run again after a tick — React may have just mounted the tutorial
  await page.waitForTimeout(150);
  await page.evaluate((script) => {
    // eslint-disable-next-line no-new-func
    new Function(script)();
  }, HIDE_NEXT_SCRIPT);
}

async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate(
    (t) => {
      const s: any = (window as any).__cairnStoreRef?.getState?.();
      if (s?.setTheme) s.setTheme(t);
      else {
        document.documentElement.setAttribute("data-theme", t);
      }
      // Force accent + chat theme to re-resolve for the new mode (applyTheme does this internally)
      // but the mock's setTheme is a noop — so poke the CSS var directly if needed.
      document.documentElement.setAttribute("data-theme", t);
    },
    theme,
  );
  // Also set the prefers-color-scheme emulation for any media-query based tokens
  // is handled by playwright via colorScheme at context level; we also force data-theme above.
  await page.waitForTimeout(250);
}

async function goToView(page: Page, view: string): Promise<void> {
  await page.evaluate(
    ({ view: v, projId }) => {
      const s: any = (window as any).__cairnStoreRef?.getState?.();
      if (!s) throw new Error("store not ready");
      if (s.chatOpen) s.toggleChat();
      if (s.searchOpen) s.toggleSearch();
      if (s.notificationOpen) s.setNotificationOpen(false);
      s.setView(v);
      if (s.activeProjectId !== projId) s.setActiveProject(projId);
    },
    { view, projId: PROJ_A },
  );
  await page.waitForTimeout(600);
  await prepareForScreenshots(page);
  // Content-aware settle: wait for view-specific DOM before capture so
  // overview/notes never screenshot as empty skeleton.
  if (view === "overview") {
    await page.waitForFunction(() => document.body.innerText.includes("Cairn — Personal Knowledge Base"), { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(200);
  } else if (view === "notes") {
    await page.waitForSelector('[data-note-id], [data-tutorial="notes-editor"]', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(200);
  } else if (view === "board") {
    await page.waitForSelector('[data-testid="kanban-board"], [class*="kanban"]', { timeout: 5000 }).catch(() => {});
  }
}

test.describe("screenshots", () => {
  test.setTimeout(120_000);

  // Build one browser context per theme — reuse the Next dev server
  for (const theme of THEMES) {
    test(`capture ${theme} — all views → ${SITE_DIR}${theme === "dark" ? "/dark" : ""}`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: theme, // matches data-theme for accurate screenshots
      });
      const page = await context.newPage();

      // Mock Electron IPC before React boots — rich fixture
      await page.addInitScript({ content: buildScreenshotMock() });
      // Mirror the smoke test's store bridge
      await page.addInitScript({
        content: `Object.defineProperty(window,'__cairnStore',{get(){return window.__cairnStoreRef},set(v){window.__cairnStoreRef=v},configurable:true});`,
      });
      // Don't show onboarding — we have a workspace
      // (needsWorkspaceSetup false in the mock)

      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-testid='sidebar'], nav, aside", { timeout: 20_000 });
      await page.waitForTimeout(500);
      await setTheme(page, theme);
      await prepareForScreenshots(page);

      for (const shot of SHOTS) {
        // Skip shots that write outside SITE_DIR root (defensive — docs subfolder is allowed)
        const outRoot = theme === "dark" ? path.join(SITE_DIR, "dark") : SITE_DIR;
        const outPath = path.join(outRoot, shot.file);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });

        await goToView(page, shot.view);
        if (shot.setup) await shot.setup(page);
        await prepareForScreenshots(page);
        // Let fonts + D3 settle (Geist from Google Fonts, canvas layout)
        await page.waitForTimeout(400);

        // Full window screenshot (title bar + sidebar + content). Matches
        // site's existing framing (title bar included, OS chrome not).
        await page.screenshot({ path: outPath, fullPage: false });
        const stat = fs.statSync(outPath);
        console.log(`[screenshots:${theme}] ${shot.file} → ${outPath} (${Math.round(stat.size / 1024)} KB)`);

        // Guard: never let a "Next" button slip into a shipped screenshot
        // (sample the DOM before moving to the next view)
        const nextVisible = await page.evaluate(() => {
          const re = /^(Next|Next Feature)$/;
          for (const b of document.querySelectorAll("button")) {
            if (re.test((b.textContent ?? "").trim())) {
              const style = getComputedStyle(b);
              if (style.display !== "none" && style.visibility !== "hidden" && b.offsetParent !== null) return true;
            }
          }
          return false;
        });
        expect(nextVisible, `"Next" button must be hidden in ${shot.file} (${theme})`).toBe(false);
      }

      await context.close();
    });
  }
});
