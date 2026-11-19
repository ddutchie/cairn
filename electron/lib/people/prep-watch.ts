/**
 * Starts a prep brief ahead of a calendar meeting (W6): on each scheduler tick,
 * for a person with a cadence on the invite of a calendar meeting that starts
 * within the lead time, when they have no brief for today. One run at a time,
 * and each (person, meeting) is tried once per app session, so a failing run
 * never loops. Does nothing while the People preview is off.
 */

import { localDate } from "../../../shared/today/brief";
import { duePrepTargets, PREP_LEAD_MS } from "../../db/people-oneonone";
import { isPeopleEnabled } from "../../db/people-queries";
import { runPrepNow, type AutomationRunContext } from "../heartbeat-runner";
import { findPrepAutomation, isPrepRunning, loadPrepBrief } from "./prep";

const tried = new Set<string>();
/** Automatic briefs per day: the Prep button is unlimited, a calendar full of meetings isn't. */
export const AUTO_PREPS_PER_DAY = 5;
const startedByDay = new Map<string, number>();

export interface PrepWatchDeps {
  run?: typeof runPrepNow;
  leadMs?: number;
}

/** Returns how many briefs were started (at most one per tick). */
export function tickMeetingPreps(ctx: AutomationRunContext, nowMs: number, deps: PrepWatchDeps = {}): number {
  const { db } = ctx;
  if (!isPeopleEnabled(db)) return 0;
  const run = deps.run ?? runPrepNow;
  const date = localDate(new Date(nowMs));
  if ((startedByDay.get(date) ?? 0) >= AUTO_PREPS_PER_DAY) return 0;
  for (const { id: workspaceId } of db.prepare("SELECT id FROM workspaces").all() as Array<{ id: string }>) {
    const automation = findPrepAutomation(db, workspaceId);
    for (const target of duePrepTargets(db, workspaceId, nowMs, deps.leadMs ?? PREP_LEAD_MS)) {
      const key = `${target.personId}|${target.meetingId}|${date}`;
      if (tried.has(key)) continue;
      // A brief from today (even a failed one) is enough: the Prep button runs it again on demand.
      // A placeholder whose run is gone (a crash) doesn't count; a finished or failed brief does.
      const have = automation ? loadPrepBrief(ctx.workspacePath, automation, target.personId, date) : null;
      if (have && !(have.status === "gathering" && !isPrepRunning(target.personId))) { tried.add(key); continue; }
      const result = run(ctx, workspaceId, { personId: target.personId, meetingId: target.meetingId });
      if ("runId" in result) { tried.add(key); startedByDay.set(date, (startedByDay.get(date) ?? 0) + 1); return 1; }
      // Busy or no AI connection: try again next tick. Off or unknown person: never.
      if (result.skipped === "busy" || result.skipped === "no-ai") return 0;
      tried.add(key);
    }
  }
  return 0;
}

/** Test seam. */
export function resetPrepWatch(): void { tried.clear(); startedByDay.clear(); }
