/**
 * plan-fold — fold `plan/mode` session events to the committed plan state.
 *
 * Replaces upstream `foldPlanMode` from `@deepseek-ai/dsh-plan-mode`, removed
 * in dsh `0.1.2-alpha.4` in favour of the `plan` session projection
 * (`PlanProjection { active, pending }`). Cairn's call sites only need the
 * committed boolean right after running `/plan` | `/plan off` through
 * `ctx.commands.execute`, so a last-wins fold over `plan/mode` events is the
 * exact equivalent — without taking a dependency on the projections registry.
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
