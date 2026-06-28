/**
 * Regression tests for completeOnboarding — the onboarding-completion flow.
 *
 * The bug this guards: a brand-new user finished onboarding but the store was
 * never re-hydrated from SQLite, so they had no access to their projects on
 * first run (workaround: reopen the app). The fix hydrates BEFORE dismissing
 * onboarding. These tests pin both the hydration call and its ordering.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { completeOnboarding, type CompleteOnboardingDeps } from "./complete-onboarding";
import type { NewFeature } from "./new-features-registry";

const feat = (id: string, version: string): NewFeature => ({
  id,
  version,
  title: id,
  category: "Test",
  description: "",
  highlights: [],
});

function makeDeps(overrides: Partial<CompleteOnboardingDeps> = {}): {
  deps: CompleteOnboardingDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: CompleteOnboardingDeps = {
    hydrateFromElectron: vi.fn(async () => { calls.push("hydrate"); }),
    setOnboardingState: vi.fn(() => { calls.push("exit"); }),
    setPendingTutorial: vi.fn(() => { calls.push("pendingTutorial"); }),
    setTutorialActive: vi.fn(() => { calls.push("tutorialActive"); }),
    seenFeatures: [],
    registry: [feat("v1.0-a", "v1.0")],
    ...overrides,
  };
  return { deps, calls };
}

describe("completeOnboarding", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hydrates from the backend before exiting onboarding (the core fix)", async () => {
    const { deps, calls } = makeDeps();
    await completeOnboarding(false, deps);

    expect(deps.hydrateFromElectron).toHaveBeenCalledTimes(1);
    expect(deps.setOnboardingState).toHaveBeenCalledWith(false);
    // Ordering matters: hydrate must resolve BEFORE onboarding is dismissed,
    // otherwise the main app renders with an empty store (no projects).
    expect(calls.indexOf("hydrate")).toBeLessThan(calls.indexOf("exit"));
  });

  it("awaits a slow hydrate before dismissing onboarding", async () => {
    let resolved = false;
    const { deps } = makeDeps({
      hydrateFromElectron: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 10));
        resolved = true;
      }),
    });

    await completeOnboarding(false, deps);

    // setOnboardingState only runs after the awaited hydrate settled.
    expect(resolved).toBe(true);
    expect(deps.setOnboardingState).toHaveBeenCalledWith(false);
  });

  it("does not start any tour when startTour is false", async () => {
    const { deps } = makeDeps();
    await completeOnboarding(false, deps);

    expect(deps.setPendingTutorial).not.toHaveBeenCalled();
    expect(deps.setTutorialActive).not.toHaveBeenCalled();
  });

  it("defers the tour when there are unseen latest-version features", async () => {
    const { deps } = makeDeps({ seenFeatures: [], registry: [feat("v9.9-new", "v9.9")] });
    await completeOnboarding(true, deps);

    expect(deps.setPendingTutorial).toHaveBeenCalledWith(true);
    expect(deps.setTutorialActive).not.toHaveBeenCalled();
  });

  it("starts the tour immediately when the latest feature is already seen", async () => {
    const { deps } = makeDeps({
      seenFeatures: ["v9.9-new"],
      registry: [feat("v9.9-new", "v9.9")],
    });
    await completeOnboarding(true, deps);

    expect(deps.setTutorialActive).toHaveBeenCalledWith(true);
    expect(deps.setPendingTutorial).not.toHaveBeenCalled();
  });

  it("still hydrates and exits when starting the tour", async () => {
    const { deps, calls } = makeDeps({ registry: [feat("v9.9-new", "v9.9")] });
    await completeOnboarding(true, deps);

    expect(deps.hydrateFromElectron).toHaveBeenCalledTimes(1);
    expect(calls.indexOf("hydrate")).toBeLessThan(calls.indexOf("exit"));
  });
});
