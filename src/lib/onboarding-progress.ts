/**
 * Marks a first run that created its workspace but hasn't reached "Open Cairn",
 * so quitting partway resumes the wizard on the next launch. A marker is used
 * rather than "workspace with no projects" because an existing user can delete
 * every project and must not be sent back through onboarding.
 *
 * All of this only helps a restart, so a storage failure must never interrupt
 * the wizard or stop the app from loading: it just loses the resume.
 */
const ONBOARDING_IN_PROGRESS_KEY = "onboardingInProgress";
/** The vault import under review, so quitting doesn't lose its review and Undo. */
const PENDING_IMPORT_KEY = "onboardingPendingImport";

export interface PendingImportProject {
  id: string;
  name: string;
  noteCount: number;
}

function tryStorage<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

export function markOnboardingInProgress(): void {
  tryStorage(() => localStorage.setItem(ONBOARDING_IN_PROGRESS_KEY, "1"), undefined);
}

export function clearOnboardingInProgress(): void {
  tryStorage(() => localStorage.removeItem(ONBOARDING_IN_PROGRESS_KEY), undefined);
  clearPendingImport();
}

export function isOnboardingInProgress(): boolean {
  return tryStorage(() => localStorage.getItem(ONBOARDING_IN_PROGRESS_KEY) !== null, false);
}

export function savePendingImport(projects: PendingImportProject[]): void {
  tryStorage(() => localStorage.setItem(PENDING_IMPORT_KEY, JSON.stringify(projects)), undefined);
}

export function clearPendingImport(): void {
  tryStorage(() => localStorage.removeItem(PENDING_IMPORT_KEY), undefined);
}

/** The saved import, limited to projects that still exist. */
export function readPendingImport(existing: ReadonlyArray<{ id: string }>): PendingImportProject[] {
  return tryStorage(() => {
    const saved: unknown = JSON.parse(localStorage.getItem(PENDING_IMPORT_KEY) ?? "[]");
    if (!Array.isArray(saved)) return [];
    const ids = new Set(existing.map((p) => p.id));
    return (saved as PendingImportProject[]).filter((p) => ids.has(p?.id));
  }, []);
}
