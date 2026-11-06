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
} {
  const deps: CompleteOnboardingDeps = {
    hydrateFromElectron: vi.fn(async () => {}),
    setOnboardingState: vi.fn(),
    setTutorialActive: vi.fn(),
    markFeatureAsSeen: vi.fn(),
    clearOnboardingInProgress: vi.fn(),
    registry: [feat("v1.0-a", "v1.0")],
    ...overrides,
  };
  return { deps };
}

describe("completeOnboarding", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hydrates from the backend and only then exits onboarding (the core fix)", async () => {
    // Control hydrate's resolution so we can prove setOnboardingState is GATED
    // on it — not merely that the final recorded order happens to be right.
    let resolveHydrate!: () => void;
    const hydrateFromElectron = vi.fn(
      () => new Promise<void>((resolve) => { resolveHydrate = resolve; }),
    );
    const { deps } = makeDeps({ hydrateFromElectron });

    // Start the flow but do NOT await — hydrate is still pending.
    const done = completeOnboarding(false, deps);
    await Promise.resolve(); // flush any microtasks up to the first await

    expect(deps.hydrateFromElectron).toHaveBeenCalledTimes(1);
    // Onboarding must NOT be dismissed while hydration is in flight, otherwise
    // the main app renders against an empty store (no projects on first run).
    expect(deps.setOnboardingState).not.toHaveBeenCalled();

    // Resolve hydration; the dismiss should now run.
    resolveHydrate();
    await done;
    expect(deps.setOnboardingState).toHaveBeenCalledWith(false);
  });

  it("does not start any tour when startTour is false", async () => {
    const { deps } = makeDeps();
    await completeOnboarding(false, deps);

    expect(deps.setTutorialActive).not.toHaveBeenCalled();
  });

  it("starts the tour when asked", async () => {
    const { deps } = makeDeps();
    await completeOnboarding(true, deps);

    expect(deps.setTutorialActive).toHaveBeenCalledWith(true);
  });

  it("marks every What's New card seen before leaving the wizard", async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      registry: [feat("v9.8-old", "v9.8"), feat("v9.9-new", "v9.9")],
      markFeatureAsSeen: vi.fn((id: string) => { order.push(id); }),
      setOnboardingState: vi.fn(() => { order.push("exit"); }),
    });
    await completeOnboarding(false, deps);

    expect(order).toEqual(["v9.8-old", "v9.9-new", "exit"]);
  });

  it("clears the in-progress marker so the next launch opens the app", async () => {
    const { deps } = makeDeps();
    await completeOnboarding(false, deps);

    expect(deps.clearOnboardingInProgress).toHaveBeenCalledTimes(1);
  });

  it("gates exit AND tour start on hydration when starting the tour", async () => {
    let resolveHydrate!: () => void;
    const hydrateFromElectron = vi.fn(
      () => new Promise<void>((resolve) => { resolveHydrate = resolve; }),
    );
    const { deps } = makeDeps({ hydrateFromElectron });

    const done = completeOnboarding(true, deps);
    await Promise.resolve();

    expect(deps.hydrateFromElectron).toHaveBeenCalledTimes(1);
    // Nothing past the await should have run while hydration is pending.
    expect(deps.setOnboardingState).not.toHaveBeenCalled();
    expect(deps.setTutorialActive).not.toHaveBeenCalled();

    resolveHydrate();
    await done;
    expect(deps.setOnboardingState).toHaveBeenCalledWith(false);
    expect(deps.setTutorialActive).toHaveBeenCalledWith(true);
  });
});
