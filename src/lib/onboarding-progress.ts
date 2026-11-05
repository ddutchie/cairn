/**
 * Marks a first run that created its workspace but hasn't reached "Open Cairn",
 * so quitting partway resumes the wizard on the next launch. A marker is used
 * rather than "workspace with no projects" because an existing user can delete
 * every project and must not be sent back through onboarding.
 */
const ONBOARDING_IN_PROGRESS_KEY = "onboardingInProgress";

export function markOnboardingInProgress(): void {
  localStorage.setItem(ONBOARDING_IN_PROGRESS_KEY, "1");
}

export function clearOnboardingInProgress(): void {
  localStorage.removeItem(ONBOARDING_IN_PROGRESS_KEY);
}

export function isOnboardingInProgress(): boolean {
  return localStorage.getItem(ONBOARDING_IN_PROGRESS_KEY) !== null;
}
