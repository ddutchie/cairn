import type { NewFeature } from "./new-features-registry";

/**
 * Dependencies for {@link completeOnboarding}, injected so the flow can be
 * unit-tested without rendering the whole app shell.
 */
export interface CompleteOnboardingDeps {
  /** Re-sync the Zustand store from the SQLite backend (workspaces, projects, …). */
  hydrateFromElectron: () => Promise<void>;
  /** Exit the onboarding wizard and show the main app. */
  setOnboardingState: (v: false) => void;
  /** Activate the interactive tour. */
  setTutorialActive: (v: boolean) => void;
  /** Record a "What's New" card as seen. */
  markFeatureAsSeen: (id: string) => void;
  /** Forget that a first run is in progress, so the next launch opens the app. */
  clearOnboardingInProgress: () => void;
  /** The "What's New" feature registry. */
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
 * Someone finishing onboarding has nothing to compare "What's New" against, so
 * every current card is marked seen. That also happens after hydration (which
 * restores `seenFeatures`) and before the wizard exits, so the modal can't flash.
 */
export async function completeOnboarding(
  startTour: boolean,
  deps: CompleteOnboardingDeps,
): Promise<void> {
  await deps.hydrateFromElectron();
  for (const feature of deps.registry) deps.markFeatureAsSeen(feature.id);
  deps.clearOnboardingInProgress();
  deps.setOnboardingState(false);
  if (startTour) deps.setTutorialActive(true);
}
