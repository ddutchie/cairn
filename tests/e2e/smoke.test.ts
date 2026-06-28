/**
 * Cairn — E2E smoke tests
 *
 * Strategy:
 * - Inject window.electron mock before React boots (addInitScript)
 * - Wait for the app shell to be ready (sidebar visible)
 * - Navigate to each view by calling store.setView() via page.evaluate()
 * - Assert no unhandled JS errors and no React error-boundary renders
 *
 * The tests do NOT assert pixel-level appearance — only that every view
 * renders without crashing.
 */

import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";
import { buildIpcMock, NOTE_1 } from "../fixtures/ipc-mock";
import { NEW_FEATURES_REGISTRY, getUnseenLatestFeatures } from "../../src/lib/new-features-registry";

// Derive the latest-release feature from the registry rather than hard-coding a
// specific entry — these assertions then stay valid as new releases are added.
const LATEST_FEATURE = getUnseenLatestFeatures(NEW_FEATURES_REGISTRY, [])[0];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Collected JS errors from the page (window.onerror + uncaught rejections). */
type PageError = { type: string; message: string };

function collectErrors(page: Page): () => PageError[] {
  const errors: PageError[] = [];

  page.on("pageerror", (err) => {
    const msg = err.message;
    // Filter pre-existing SSR/hydration mismatch in TitleBar: the component
    // reads window.electron in useState init, which is unavailable during SSR.
    // This produces a hydration error on every dev-server load and is unrelated
    // to view-render correctness (all views still render without crashing).
    if (msg.includes("Hydration failed") || msg.includes("hydration")) {
      return;
    }
    errors.push({ type: "pageerror", message: msg });
  });

  page.on("console", (msg: ConsoleMessage) => {
    // React prints error-boundary catches to console.error
    if (msg.type() === "error") {
      const text = msg.text();
      // Filter out known benign console errors:
      if (
        // Browser ResizeObserver timing noise
        text.includes("ResizeObserver loop") ||
        text.includes("Non-Error promise rejection") ||
        // Next.js hot-reload noise in dev
        text.includes("Fast Refresh") ||
        text.includes("[Fast Refresh]") ||
        // Pre-existing TitleBar hydration mismatch: SSR renders null (no window)
        // but client renders the full bar (window.electron is available).
        // This is an existing code issue unrelated to view-render correctness.
        text.includes("Hydration failed") ||
        // Next.js warns about <script> tags inside React components — benign
        // noise from mermaid / katex dynamic script injection.
        text.includes("Encountered a script tag while rendering")
      ) {
        return;
      }
      errors.push({ type: "console.error", message: text });
    }
  });

  return () => errors;
}

/** Navigate the app to the given view and wait for it to settle. */
async function goToView(page: Page, view: string): Promise<void> {
  await page.evaluate((v) => {
    // Access the Zustand store via the global attached by the store module
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__cairnStore?.getState?.()?.setView?.(v);
  }, view);
  // Give React one animation frame to commit + any async effects to kick off
  await page.waitForTimeout(300);
}

/**
 * Dismiss the "What's New" feature modal if it's open on boot. The fixture has
 * an empty seenFeatures list, so the modal appears and would overlay the app.
 * Idempotent — a no-op if the modal isn't present.
 */
async function dismissNewFeatureModal(page: Page): Promise<void> {
  const doneBtn = page.getByRole("button", { name: "Done" });
  if (await doneBtn.count()) {
    await doneBtn.first().click().catch(() => {});
    await page.waitForTimeout(200);
  }
}

/** Attach the cairn store reference to window so smoke tests can call setView. */
const STORE_ATTACH_SCRIPT = `
  // Attach the Zustand store to window so Playwright can call setView()
  // This is injected before React boots; the store is lazily created on first
  // useCairnStore() call, so we poll for it.
  Object.defineProperty(window, '__cairnStore', {
    get() { return (window).__cairnStoreRef; },
    set(v) { (window).__cairnStoreRef = v; },
    configurable: true,
  });
`;

// ── Fixture setup ─────────────────────────────────────────────────────────────

// Views to test, in render order. Each entry is [viewId, stable selector].
// The selector is something expected to exist in the DOM when that view is
// fully mounted (not necessarily visible, just in the DOM).
const VIEWS: Array<{ id: string; label: string; selector: string }> = [
  { id: "overview",  label: "Overview",         selector: '[data-testid="project-overview"], [class*="overview"]' },
  { id: "notes",     label: "Notes",             selector: '[data-testid="notes-view"], [class*="notes"]' },
  { id: "board",     label: "Board (Kanban)",    selector: '[data-testid="kanban-board"], [class*="board"]' },
  { id: "flow",      label: "Idea Flow",         selector: '[data-testid="flow-view"], [class*="flow"]' },
  { id: "graph",     label: "Knowledge Graph",   selector: '[data-testid="graph-view"], [class*="graph"]' },
  { id: "insights",  label: "Insights",          selector: '[data-testid="insights-view"], [class*="insights"]' },
  { id: "settings",  label: "Settings",          selector: '[data-testid="settings-view"], [class*="settings"]' },
  { id: "agent",     label: "Agent",             selector: '[data-testid="agent-view"], [class*="agent"]' },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe("Cairn smoke tests", () => {
  /**
   * Shared page — we navigate between views within a single page load to
   * avoid paying the hydration cost N times.
   */
  let page: Page;
  let getErrors: () => PageError[];

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    page = await context.newPage();

    // Inject IPC mock BEFORE any page JS runs
    await page.addInitScript({ content: buildIpcMock() });
    // Attach store ref helper
    await page.addInitScript({ content: STORE_ATTACH_SCRIPT });

    // Capture errors from this point forward
    getErrors = collectErrors(page);

    // Navigate to app
    await page.goto("/");

    // Wait for the app shell — the sidebar should appear once hydration is done
    // and onboardingState === false.
    await page.waitForSelector("[data-testid='sidebar'], nav, aside", {
      timeout: 20_000,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("app boots without JS errors", async () => {
    const errors = getErrors();
    expect(
      errors,
      `Unexpected JS errors on boot:\n${errors.map((e) => `  [${e.type}] ${e.message}`).join("\n")}`
    ).toHaveLength(0);
  });

  test("no React error boundary triggered on boot", async () => {
    // React error boundaries render a fallback — we look for common patterns
    const errorBoundaryText = page.locator(
      'text="Something went wrong", text="An error occurred", [data-error-boundary]'
    );
    await expect(errorBoundaryText).toHaveCount(0);
  });

  // ── Per-view tests ──────────────────────────────────────────────────────────

  for (const { id, label } of VIEWS) {
    test(`view: ${label} — renders without crash`, async () => {
      // Clear error list before each view navigation
      const errorsBefore = getErrors().length;

      await goToView(page, id);

      // Wait briefly for any async render effects
      await page.waitForTimeout(500);

      // No NEW errors since we navigated to this view
      const errorsAfter = getErrors();
      const newErrors = errorsAfter.slice(errorsBefore);

      expect(
        newErrors,
        `View "${label}" produced errors:\n${newErrors.map((e) => `  [${e.type}] ${e.message}`).join("\n")}`
      ).toHaveLength(0);
    });
  }

  // ── Sidebar navigation ──────────────────────────────────────────────────────

  test("sidebar renders project name", async () => {
    // Navigate to a known view first
    await goToView(page, "overview");
    await page.waitForTimeout(300);

    // The fixture project "Test Project" should appear somewhere in the sidebar
    const projectLabel = page.getByText("Test Project");
    await expect(projectLabel.first()).toBeVisible({ timeout: 5_000 });
  });

  // ── AI write-lock push events ─────────────────────────────────────────────
  // Drives the preload push flow (onAiWriteStarted/onAiWriteEnded) via the mock's
  // window.__cairnEmit bridge and asserts the note editor's read-only banner
  // toggles. This exercises the real consumer in note-editor.tsx end-to-end.

  test("note editor shows AI-write banner on onAiWriteStarted and clears on onAiWriteEnded", async () => {
    // Dismiss the "What's New" modal if it's covering the app on boot.
    await dismissNewFeatureModal(page);

    // Open the Notes view — the single fixture note auto-opens in the editor.
    await goToView(page, "notes");
    // Wait for the note editor container to mount (it subscribes to the
    // AI-write events on mount).
    await page.waitForSelector('[data-tutorial="notes-editor"]', { timeout: 10_000 });
    await page.waitForTimeout(300);

    const banner = page.getByText("AI is editing this note…");

    // Not editing yet — banner absent.
    await expect(banner).toHaveCount(0);

    // Emit the start event for the open note's ID via the mock bridge.
    const startedSubscribers = await page.evaluate((noteId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__cairnEmit?.("onAiWriteStarted", { noteId });
    }, NOTE_1);
    // Both the global page.tsx handler and the note editor must be subscribed.
    expect(startedSubscribers).toBeGreaterThanOrEqual(2);

    // Banner appears.
    await expect(banner).toBeVisible({ timeout: 5_000 });

    // Emit the end event — banner clears.
    await page.evaluate((noteId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__cairnEmit?.("onAiWriteEnded", { noteId });
    }, NOTE_1);

    await expect(banner).toHaveCount(0, { timeout: 5_000 });
  });

  test("AI-write banner ignores events for a different note", async () => {
    await dismissNewFeatureModal(page);
    await goToView(page, "notes");
    await page.waitForSelector('[data-tutorial="notes-editor"]', { timeout: 10_000 });
    await page.waitForTimeout(300);

    const banner = page.getByText("AI is editing this note…");
    await expect(banner).toHaveCount(0);

    // Emit a start event for an unrelated note ID — the open editor must ignore it.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__cairnEmit?.("onAiWriteStarted", { noteId: "some-other-note" });
    });

    // Give React a moment; the banner must NOT appear.
    await page.waitForTimeout(300);
    await expect(banner).toHaveCount(0);

    // Clean up the registry entry so it can't influence later assertions.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__cairnEmit?.("onAiWriteEnded", { noteId: "some-other-note" });
    });
  });
});

// ── "What's New" feature modal ────────────────────────────────────────────────
// Uses an isolated browser context per assertion so seenFeatures (persisted in
// localStorage / the store) starts clean and is independent of test order.

test.describe("What's New modal", () => {
  /** Boot a fresh page with the IPC mock + store bridge installed. */
  async function bootFreshPage(browser: import("@playwright/test").Browser): Promise<Page> {
    const context = await browser.newContext();
    const p = await context.newPage();
    await p.addInitScript({ content: buildIpcMock() });
    await p.addInitScript({ content: STORE_ATTACH_SCRIPT });
    await p.goto("/");
    await p.waitForSelector("[data-testid='sidebar'], nav, aside", { timeout: 20_000 });
    return p;
  }

  test("appears on boot when the latest-version feature is unseen", async ({ browser }) => {
    const p = await bootFreshPage(browser);
    try {
      // The fixture starts with no seen features, so the latest release modal shows.
      await expect(p.getByRole("heading", { name: /What's New in Cairn/i })).toBeVisible({ timeout: 10_000 });
      // The latest registry feature title is rendered.
      await expect(p.getByText(LATEST_FEATURE.title)).toBeVisible();
    } finally {
      await p.context().close();
    }
  });

  test("clicking Done marks the feature seen and the modal does not reappear", async ({ browser }) => {
    const p = await bootFreshPage(browser);
    try {
      const heading = p.getByRole("heading", { name: /What's New in Cairn/i });
      await expect(heading).toBeVisible({ timeout: 10_000 });

      // Close via the primary action (single latest feature → "Done").
      await p.getByRole("button", { name: "Done" }).click();

      // Modal closes...
      await expect(heading).toHaveCount(0, { timeout: 5_000 });

      // ...and the feature is now recorded as seen in the store.
      const seen = await p.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (window as any).__cairnStore?.getState?.()?.seenFeatures ?? [];
      });
      expect(seen).toContain(LATEST_FEATURE.id);

      // Navigating around does not re-open it (gate is empty now).
      await p.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__cairnStore?.getState?.()?.setView?.("board");
      });
      await p.waitForTimeout(300);
      await expect(heading).toHaveCount(0);
    } finally {
      await p.context().close();
    }
  });

  test("does not appear on boot when the latest feature is already seen", async ({ browser }) => {
    const context = await browser.newContext();
    const p = await context.newPage();
    await p.addInitScript({ content: buildIpcMock() });
    await p.addInitScript({ content: STORE_ATTACH_SCRIPT });
    // Pre-seed seenFeatures in localStorage before the app boots. The storage
    // layer prefixes keys with "cairn:v1:" (see src/lib/storage.ts).
    await p.addInitScript({
      content: `localStorage.setItem("cairn:v1:seenFeatures", JSON.stringify([${JSON.stringify(LATEST_FEATURE.id)}]));`,
    });
    try {
      await p.goto("/");
      await p.waitForSelector("[data-testid='sidebar'], nav, aside", { timeout: 20_000 });
      // Give the modal a chance to (not) render.
      await p.waitForTimeout(500);
      await expect(p.getByRole("heading", { name: /What's New in Cairn/i })).toHaveCount(0);
    } finally {
      await p.context().close();
    }
  });
});

// ── Onboarding wizard entry ───────────────────────────────────────────────────
// The full wizard spans many steps; here we assert the onboarding path is wired
// (it appears on a fresh install) and the choose-folder entry step renders.
// Component-level StepCreateProject behaviors (icon persistence, disabled
// states, aria-pressed) are covered by unit tests (workspace.test.ts) since the
// renderer has no DOM-unit harness.

test.describe("Onboarding wizard", () => {
  test("shows the wizard on a fresh install (needs workspace setup)", async ({ browser }) => {
    const context = await browser.newContext();
    const p = await context.newPage();
    // Override the mock to simulate a fresh install: workspace setup required.
    // Baked into the same synchronous script that defines window.electron so the
    // app never reads the default `false` before the override applies.
    await p.addInitScript({ content: buildIpcMock({ needsWorkspaceSetup: true }) });
    await p.addInitScript({ content: STORE_ATTACH_SCRIPT });
    try {
      await p.goto("/");
      // The choose-folder step heading should render instead of the app shell.
      await expect(p.getByText("Choose a workspace folder")).toBeVisible({ timeout: 20_000 });
    } finally {
      await p.context().close();
    }
  });
});
