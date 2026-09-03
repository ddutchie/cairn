/**
 * plan-fold — read the committed plan state for a session.
 *
 * Primary path is the upstream `plan` session projection
 * (`PlanProjection { active, pending }`, key `"plan"`, registered by
 * `@deepseek-ai/dsh-plan-mode` with the already-mounted `sessionProjections`
 * registry) — no event scanning. Fallback is a last-`plan/mode`-wins fold for
 * contexts where the projections registry is unavailable (plain-object
 * sessions in tests, pre-registry code paths).
 *
 * Reads the session through the alpha.4+ on-demand APIs
 * (`snapshotEvents()` → `ownEvents()`), with a legacy `.events` fallback for
 * tests that hand us a plain object.
 */

interface FoldableSession {
  snapshotEvents?: () => readonly unknown[];
  ownEvents?: () => readonly unknown[];
  events?: readonly unknown[];
}

interface PlanModeEvent {
  type?: unknown;
  data?: { active?: unknown } | null;
}

/** Committed plan state: last `plan/mode` wins; inactive before the first. */
export function foldPlanModeActive(session: FoldableSession | undefined | null): boolean {
  const events =
    (typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : undefined) ??
    (typeof session?.ownEvents === "function" ? session.ownEvents() : undefined) ??
    session?.events ??
    [];
  let active = false;
  for (const e of events) {
    const ev = e as PlanModeEvent;
    if (ev?.type === "plan/mode") {
      active = ev?.data?.active === true;
    }
  }
  return active;
}

interface ProjectionRegistry {
  stateOf: (session: unknown, key: string) => unknown;
}

/**
 * Committed plan state via the upstream `plan` projection when the context
 * carries a `sessionProjections` registry, else the `plan/mode` event fold.
 * Call sites that already hold the Cordis context should prefer this over
 * `foldPlanModeActive` — the projection is what dsh itself reads
 * (`planMode.get`), so the two can never disagree.
 */
export function getPlanModeActive(ctx: unknown, session: unknown): boolean {
  try {
    const registry = (ctx as { sessionProjections?: ProjectionRegistry } | undefined)?.sessionProjections;
    const state = registry?.stateOf(session as never, "plan") as { active?: unknown } | undefined;
    if (state && typeof state.active === "boolean") return state.active;
  } catch { /* fall through to the event fold */ }
  return foldPlanModeActive(session as FoldableSession | undefined | null);
}
