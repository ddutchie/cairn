/**
 * schedule-read — on-demand active-reminder snapshot for the header alarm pill.
 *
 * dsh-schedule 0.1.7 keeps reminders in the shared storage domain (not the
 * session log), so this reads `ctx.schedule.list({ sessionId })` and renders
 * each record with `scheduleView(record, Date.now())` for its scheduled/overdue
 * state — the same value shape `schedule_list` returns, without starting or
 * resuming an agent. No standing subscription: the pill polls this on header
 * mount and turn end via the `session:schedule-list` IPC channel.
 *
 * Returns an empty list (pill hides) when the schedule service is not mounted
 * (setting off) or the read fails.
 */

import type { Context } from "@deepseek-ai/cordis";
import { scheduleView, type ScheduleRecord } from "@deepseek-ai/dsh-schedule";
import { SessionId } from "@deepseek-ai/dsh-session";

/** Renderer-safe reminder summary (schedule_list view subset). */
export interface ScheduleWire {
  id: string;
  prompt: string;
  scheduledAt: string;
  kind: string;
  state: "scheduled" | "overdue";
}

interface CordisLike {
  schedule?: { list?: (request: { sessionId: SessionId }) => Promise<ScheduleRecord[]> };
}

/**
 * List active reminders for one session. Empty when the overlay is disabled
 * or the session has no reminders — the pill hides in both cases.
 */
export async function listSchedules(ctx: Context, sessionId: string): Promise<ScheduleWire[]> {
  const cordis = ctx as unknown as CordisLike;
  if (typeof cordis.schedule?.list !== "function") return [];
  try {
    const records = await cordis.schedule.list({ sessionId: SessionId(sessionId) });
    const now = Date.now();
    return records.map((record) => {
      const view = scheduleView(record, now) as {
        id?: unknown; prompt?: unknown; scheduledAt?: unknown; kind?: unknown; state?: unknown;
      };
      return {
        id: String(view.id ?? ""),
        prompt: typeof view.prompt === "string" ? view.prompt : "",
        scheduledAt: typeof view.scheduledAt === "string" ? view.scheduledAt : "",
        kind: typeof view.kind === "string" ? view.kind : "after",
        state: (view.state === "overdue" ? "overdue" : "scheduled") as ScheduleWire["state"],
      };
    });
  } catch {
    return [];
  }
}
