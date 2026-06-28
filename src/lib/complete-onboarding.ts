import type { NewFeature } from "./new-features-registry";
import { getUnseenLatestFeatures } from "./new-features-registry";

/**
 * Dependencies for {@link completeOnboarding}, injected so the flow can be
 * unit-tested without rendering the whole app shell.
 */
export interface CompleteOnboardingDeps {
  /** Re-sync the Zustand store from the SQLite backend (workspaces, projects, …). */
  hydrateFromElectron: () => Promise<void>;
  /** Exit the onboarding wizard and show the main app. */
  setOnboardingState: (v: false) => void;
  /** Defer the interactive tour until the "What's New" modal is dismissed. */
  setPendingTutorial: (v: boolean) => void;
  /** Activate the interactive tour immediately. */
  setTutorialActive: (v: boolean) => void;
  /** Feature ids the user has already seen (for tour gating). */
  seenFeatures: string[];
  /** The "What's New" feature registry (for tour gating). */
  registry: NewFeature[];
}

/**
 * Runs when the onboarding wizard finishes ("Open Cairn").
 *
 * CRITICAL ORDERING (regression guard): `hydrateFromElectron()` MUST complete
 * before `setOnboardingState(false)`. On a brand-new install the project is
 * created inside the wizard but the store is only authoritative after a
 * snapshot hydrate; dismissing onboarding first left the user with no projects
 * until they reopened the app (the bug this flow fixes).
 *
 * Tour gating mirrors NewFeatureModal: only unseen features from the LATEST
 * registry version defer the tour behind the "What's New" modal; otherwise the
 * tour starts immediately.
 */
export async function completeOnboarding(
  startTour: boolean,
  deps: CompleteOnboardingDeps,
): Promise<void> {
  await deps.hydrateFromElectron();
  deps.setOnboardingState(false);
  if (!startTour) return;
  const hasUnseenLatest =
    getUnseenLatestFeatures(deps.registry, deps.seenFeatures).length > 0;
  if (hasUnseenLatest) {
    deps.setPendingTutorial(true);
  } else {
    deps.setTutorialActive(true);
  }
}
