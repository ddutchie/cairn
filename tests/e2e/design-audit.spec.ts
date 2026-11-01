/**
 * Cairn — Design audit capture (see playwright.audit.config.ts)
 *
 * One PNG per surface into design-audit/screens/<theme>/. Reuses the rich
 * marketing fixture so every surface has realistic data. Only the tutorial and
 * the What's New modal are suppressed — every other dialog stays visible.
 */

import { expect, test, type Page } from "@playwright/test";
import { buildScreenshotMock, PROJ_A } from "../fixtures/screenshot-fixture";
import * as path from "path";
import * as fs from "fs";

type Theme = "light" | "dark";
const THEMES: Theme[] =
  process.env.THEME === "light" ? ["light"] : process.env.THEME === "dark" ? ["dark"] : ["light", "dark"];
const OUT_DIR = path.resolve(__dirname, "..", "..", "design-audit", "screens");

type StoreState = Record<string, unknown> & {
  chatOpen: boolean;
  searchOpen: boolean;
  notificationOpen: boolean;
  toggleChat: () => void;
  toggleSearch: () => void;
  setNotificationOpen: (v: boolean) => void;
  setView: (v: string) => void;
  setActiveProject: (id: string) => void;
  setSettingsSection: (s: string | null) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
};

type Shot = { file: string; view: string; viewport?: { width: number; height: number }; setup?: (p: Page) => Promise<void> };
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const NARROW = { width: 900, height: 800 };

const settingsTab = (label: string) => async (p: Page) => {
  await p.getByRole("tab", { name: label, exact: true }).first().click();
  await p.waitForTimeout(300);
};
const settingsSubtab = (section: string, sub: string) => async (p: Page) => {
  await settingsTab(section)(p);
  await p.getByRole("tab", { name: sub, exact: true }).last().click();
  await p.waitForTimeout(300);
};
const openChat = async (p: Page) => {
  await p.evaluate(() => (window as unknown as { __cairnStoreRef: { getState: () => StoreState } }).__cairnStoreRef.getState().toggleChat());
  await p.waitForTimeout(600);
};

const SHOTS: Shot[] = [
  { file: "01-overview.png", view: "overview" },
  { file: "02-notes.png", view: "notes" },
  { file: "03-board.png", view: "board" },
  { file: "04-calendar.png", view: "calendar" },
  { file: "05-calendar-all.png", view: "calendar-all" },
  { file: "06-flow.png", view: "flow" },
  { file: "07-graph.png", view: "graph" },
  { file: "08-insights.png", view: "insights", setup: async (p) => { await p.waitForTimeout(800); } },
  { file: "09-agent.png", view: "agent" },
  { file: "10-automations.png", view: "automations" },
  { file: "11-usage.png", view: "usage" },
  { file: "12-chat-view.png", view: "chat" },
  { file: "13-chat-drawer.png", view: "board", setup: openChat },
  { file: "14-chat-drawer-header-menu.png", view: "board", setup: async (p) => {
    await openChat(p);
    // The session switcher (SessionBrowser) in the drawer header — not the sidebar "Conversations" tree.
    await p.locator('button[aria-haspopup="listbox"]').filter({ hasNotText: "Conversations" }).first().click();
    await p.waitForTimeout(400);
  }},
  { file: "15-search.png", view: "board", setup: async (p) => {
    await p.evaluate(() => (window as unknown as { __cairnStoreRef: { getState: () => StoreState } }).__cairnStoreRef.getState().toggleSearch());
    await p.waitForTimeout(400);
  }},
  { file: "16-notifications.png", view: "board", setup: async (p) => {
    await p.evaluate(() => (window as unknown as { __cairnStoreRef: { getState: () => StoreState } }).__cairnStoreRef.getState().setNotificationOpen(true));
    await p.waitForTimeout(400);
  }},
  { file: "17-sidebar-collapsed.png", view: "board", setup: async (p) => {
    await p.evaluate(() => (window as unknown as { __cairnStoreRef: { getState: () => StoreState } }).__cairnStoreRef.getState().toggleSidebar());
    await p.waitForTimeout(400);
  }},
  { file: "20-settings-general.png", view: "settings", setup: settingsTab("General") },
  { file: "21-settings-ai-chat.png", view: "settings", setup: settingsSubtab("AI", "Chat") },
  { file: "22-settings-ai-agents.png", view: "settings", setup: settingsSubtab("AI", "Coding Agents") },
  { file: "23-settings-ai-mcp.png", view: "settings", setup: settingsSubtab("AI", "MCP") },
  { file: "24-settings-ext-tools.png", view: "settings", setup: settingsSubtab("Extensions", "Tools") },
  { file: "25-settings-ext-commands.png", view: "settings", setup: settingsSubtab("Extensions", "Commands") },
  { file: "26-settings-embeddings.png", view: "settings", setup: settingsTab("Embeddings") },
  { file: "27-settings-writing-style.png", view: "settings", setup: settingsTab("Writing Style") },
  { file: "28-settings-sync.png", view: "settings", setup: settingsTab("Device Sync") },
  { file: "29-settings-system-shortcuts.png", view: "settings", setup: settingsSubtab("System", "Shortcuts") },
  { file: "30-settings-system-data.png", view: "settings", setup: settingsSubtab("System", "Data") },
  { file: "31-settings-system-about.png", view: "settings", setup: settingsSubtab("System", "About") },
  // Modals and menus
  { file: "40-task-detail.png", view: "board", setup: async (p) => {
    await p.getByText("Design the mobile companion app", { exact: true }).first().click();
    await p.waitForTimeout(500);
  }},
  { file: "41-card-context-menu.png", view: "board", setup: async (p) => {
    await p.getByText("Design the mobile companion app", { exact: true }).first().click({ button: "right" });
    await p.waitForTimeout(300);
  }},
  { file: "42-prd-modal.png", view: "notes", setup: async (p) => {
    await p.getByRole("button", { name: "Generate PRD with AI" }).first().click();
    await p.waitForTimeout(500);
  }},
  { file: "43-new-menu.png", view: "board", setup: async (p) => {
    await p.getByRole("button", { name: "New", exact: true }).first().click();
    await p.waitForTimeout(300);
  }},
  { file: "44-tool-builder.png", view: "settings", setup: async (p) => {
    await settingsSubtab("Extensions", "Tools")(p);
    await p.getByRole("button", { name: "Build with AI" }).first().click();
    await p.waitForTimeout(500);
  }},
  { file: "45-browse-tools.png", view: "settings", setup: async (p) => {
    await settingsSubtab("Extensions", "Tools")(p);
    await p.getByRole("button", { name: "Browse", exact: true }).first().click();
    await p.waitForTimeout(800);
  }},
  { file: "46-browse-providers.png", view: "settings", setup: async (p) => {
    await settingsSubtab("AI", "Chat")(p);
    await p.locator("button", { hasText: "Browse Community" }).first().click();
    await p.waitForTimeout(800);
  }},
  // Narrow window (900px): where layouts start to squeeze
  { file: "60-narrow-overview.png", view: "overview", viewport: NARROW },
  { file: "61-narrow-board.png", view: "board", viewport: NARROW },
  { file: "62-narrow-notes.png", view: "notes", viewport: NARROW },
  { file: "63-narrow-chat-drawer.png", view: "board", viewport: NARROW, setup: openChat },
  { file: "64-narrow-settings.png", view: "settings", viewport: NARROW, setup: settingsSubtab("AI", "Chat") },
];

// ONLY=14,20 limits a run to shots whose filename starts with those prefixes.
const ONLY = process.env.ONLY?.split(",").map((x) => x.trim()).filter(Boolean);
const wanted = (file: string) => !ONLY || ONLY.some((o) => file.startsWith(o));

const SUPPRESS = `
(() => {
  const s = window.__cairnStoreRef?.getState?.();
  if (s) {
    try { s.setFontScale(1); } catch {}
    try { s.setShellVariant("A"); } catch {}
    try { s.setTutorialActive(false); } catch {}
    const reg = window.__CAIRN_FEATURES_REGISTRY;
    if (Array.isArray(reg)) for (const f of reg) try { s.markFeatureAsSeen(f.id); } catch {}
  }
  if (!document.getElementById("audit-hide")) {
    const st = document.createElement("style");
    st.id = "audit-hide";
    st.textContent = "nextjs-portal{display:none!important} .fixed.inset-0.z-\\\\[9999\\\\]{display:none!important}";
    document.head.appendChild(st);
  }
  // What's New modal: close via its Skip All / Done buttons if present
  for (const b of document.querySelectorAll('[role="dialog"] button')) {
    const t = (b.textContent || "").trim();
    if (t === "Skip All" || t === "Done") { b.click(); break; }
  }
})();`;

async function reset(page: Page, view: string) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(
    ({ v, projId }) => {
      const s = (window as unknown as { __cairnStoreRef: { getState: () => StoreState } }).__cairnStoreRef.getState();
      if (s.chatOpen) s.toggleChat();
      if (s.searchOpen) s.toggleSearch();
      if (s.notificationOpen) s.setNotificationOpen(false);
      if (s.sidebarCollapsed) s.toggleSidebar();
      s.setActiveProject(projId);
      s.setView(v);
    },
    { v: view, projId: PROJ_A },
  );
  await page.waitForTimeout(700);
  await page.evaluate((src) => new Function(src)(), SUPPRESS);
}

test.describe("design audit", () => {
  test.setTimeout(240_000);
  for (const theme of THEMES) {
    test(`capture ${theme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: DEFAULT_VIEWPORT, colorScheme: theme });
      const page = await context.newPage();
      await page.addInitScript({ content: buildScreenshotMock() });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-testid='sidebar'], nav, aside", { timeout: 30_000 });
      await page.waitForTimeout(800);
      await page.evaluate((t) => {
        const s = (window as unknown as { __cairnStoreRef: { getState: () => { setTheme?: (v: string) => void } } }).__cairnStoreRef.getState();
        s.setTheme?.(t);
        document.documentElement.setAttribute("data-theme", t);
      }, theme);
      await page.evaluate((src) => new Function(src)(), SUPPRESS);

      const dir = path.join(OUT_DIR, theme);
      fs.mkdirSync(dir, { recursive: true });
      const failedSetups: string[] = [];
      for (const shot of SHOTS.filter((s) => wanted(s.file))) {
        await page.setViewportSize(shot.viewport ?? DEFAULT_VIEWPORT);
        await reset(page, shot.view);
        try {
          if (shot.setup) await shot.setup(page);
        } catch (e) {
          // Don't capture the current screen under this shot's name; fail the run after the rest are captured.
          failedSetups.push(shot.file);
          console.log(`[audit:${theme}] ${shot.file} setup failed: ${process.env.AUDIT_DEBUG ? (e as Error).message : (e as Error).message.split("\n")[0]}`);
          continue;
        }
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(dir, shot.file) });
        console.log(`[audit:${theme}] ${shot.file}`);
      }
      await context.close();
      expect(failedSetups, "shots whose setup failed").toEqual([]);
    });

    // Onboarding runs on a fresh-install probe, so it gets its own page.
    test(`capture ${theme} onboarding`, async ({ browser }) => {
      const folderShot = "50-onboarding-folder.png";
      const appearanceShot = "51-onboarding-appearance.png";
      test.skip(!wanted(folderShot) && !wanted(appearanceShot), "filtered out by ONLY");
      const context = await browser.newContext({ viewport: DEFAULT_VIEWPORT, colorScheme: theme });
      const page = await context.newPage();
      await page.addInitScript({ content: buildScreenshotMock({ needsWorkspaceSetup: true }) });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
      const dir = path.join(OUT_DIR, theme);
      fs.mkdirSync(dir, { recursive: true });
      if (wanted(folderShot)) {
        await page.screenshot({ path: path.join(dir, folderShot) });
        console.log(`[audit:${theme}] ${folderShot}`);
      }
      if (wanted(appearanceShot)) {
        // Dev-only ⌘⇧. jumps straight to the appearance step.
        await page.keyboard.press("ControlOrMeta+Shift+Period");
        await page.waitForTimeout(800);
        await page.screenshot({ path: path.join(dir, appearanceShot) });
        console.log(`[audit:${theme}] ${appearanceShot}`);
      }
      await context.close();
    });
  }
});
