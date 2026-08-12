/**
 * Pure milestone-crossing logic for project completion celebrations. Kept free
 * of react-native / UI singletons so it runs in the node-only mobile vitest
 * project (a `.test.ts` importing rewards.ts would drag in the RN module graph).
 */

/** Completion milestones worth celebrating, ascending. */
export const MILESTONES = [25, 50, 75, 100] as const;

/** Highest milestone already celebrated per project in this app session. */
const celebratedMilestones = new Map<string, number>();

/** Reset the per-session dedupe map (test helper / future multi-session use). */
export function __resetCelebratedMilestones(): void {
  celebratedMilestones.clear();
}

/**
 * Decide which milestone (if any) a project's completion rate has newly crossed
 * since its last celebration, and record it. Returns 0 when there is nothing
 * new to celebrate (rate at/below the previous milestone, no cards, or a
 * milestone already fired). Pure — callers own the confetti/toast side effects.
 *
 * `completionRate` is 0–100 (from `computeProjectMetrics`); `allCards` gates the
 * no-cards case (nothing to celebrate).
 */
export function nextMilestoneToCelebrate(
  projectId: string,
  completionRate: number,
  allCards: number,
): number {
  if (allCards <= 0 || completionRate <= 0) return 0;
  const prev = celebratedMilestones.get(projectId) ?? 0;
  let crossed = 0;
  for (const m of MILESTONES) {
    if (completionRate >= m && m > prev) crossed = m;
  }
  if (crossed === 0) return 0;
  celebratedMilestones.set(projectId, crossed);
  return crossed;
}
