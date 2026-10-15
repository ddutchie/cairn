/**
 * Pure list-building for the workspace switcher (kept free of expo/native
 * imports so it is unit-testable from the root vitest run).
 */

export interface SwitcherSource {
  workspaceId: string;
  name: string | null;
}

/**
 * The workspaces the switcher offers: what the shared-folder scan found, plus
 * the active workspace (always — the scan may not have surfaced it yet, may
 * have failed, or iCloud may be unavailable) and any `extra` locally-known
 * sources (e.g. the dev demo workspace). Keyed by id so a scanned entry wins
 * over an injected stub; sorted by display name.
 *
 * Never returns an empty list while a workspace is active: an empty native
 * menu doesn't open at all, which is how the switcher looked broken.
 */
export function mergeSwitcherSources(
  found: SwitcherSource[],
  active: SwitcherSource | null,
  extra: SwitcherSource[] = [],
): SwitcherSource[] {
  const byId = new Map<string, SwitcherSource>();
  for (const s of found) byId.set(s.workspaceId, s);
  for (const s of active ? [active, ...extra] : extra) {
    if (!byId.has(s.workspaceId)) byId.set(s.workspaceId, s);
  }
  return [...byId.values()].sort((a, b) =>
    (a.name ?? a.workspaceId).localeCompare(b.name ?? b.workspaceId),
  );
}
