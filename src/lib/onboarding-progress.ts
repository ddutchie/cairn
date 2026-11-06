/**
 * Marks a first run that created its workspace but hasn't reached "Open Cairn",
 * so quitting partway resumes the wizard on the next launch. A marker is used
 * rather than "workspace with no projects" because an existing user can delete
 * every project and must not be sent back through onboarding.
 */
const ONBOARDING_IN_PROGRESS_KEY = "onboardingInProgress";
/** The vault import under review, so quitting doesn't lose its review and Undo. */
const PENDING_IMPORT_KEY = "onboardingPendingImport";

export interface PendingImportProject {
  id: string;
  name: string;
  noteCount: number;
}

export function markOnboardingInProgress(): void {
  localStorage.setItem(ONBOARDING_IN_PROGRESS_KEY, "1");
}

export function clearOnboardingInProgress(): void {
  localStorage.removeItem(ONBOARDING_IN_PROGRESS_KEY);
  clearPendingImport();
}

export function isOnboardingInProgress(): boolean {
  return localStorage.getItem(ONBOARDING_IN_PROGRESS_KEY) !== null;
}

export function savePendingImport(projects: PendingImportProject[]): void {
  localStorage.setItem(PENDING_IMPORT_KEY, JSON.stringify(projects));
}

export function clearPendingImport(): void {
  localStorage.removeItem(PENDING_IMPORT_KEY);
}

/** The saved import, limited to projects that still exist. */
export function readPendingImport(existing: ReadonlyArray<{ id: string }>): PendingImportProject[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(PENDING_IMPORT_KEY) ?? "[]");
    if (!Array.isArray(saved)) return [];
    const ids = new Set(existing.map((p) => p.id));
    return (saved as PendingImportProject[]).filter((p) => ids.has(p?.id));
  } catch {
    return [];
  }
}
