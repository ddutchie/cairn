/**
 * schedule-read — on-demand active-reminder snapshot for the header alarm pill.
 *
 * Folds the session log through dsh's pure `foldScheduleEvents` (live
 * `snapshotEvents()` when the session is resident, else the durable prefix
 * via `sessionPersistence.inspect`) and renders each record with
 * `scheduleView(record, Date.now())` for its scheduled/overdue state — the
 * same value shape `schedule_list` returns, without starting or resuming an
 * agent. No standing subscription: the pill polls this on header mount and
 * turn end via the `session:schedule-list` IPC channel.
 *
 * Returns an empty list (pill hides) when the schedule overlay is not mounted
 * or the session has no log — including right after a restart with the
 * setting off. Throws a coded `unavailable` error only when the overlay is
 * expected but unreadable, so the IPC envelope can distinguish "off" from
 * "broken".
 */

import type { Context } from "@deepseek-ai/cordis";
import { foldScheduleEvents, scheduleView } from "@deepseek-ai/dsh-schedule";
import { SessionId } from "@deepseek-ai/dsh-session";

/** Renderer-safe reminder summary (schedule_list view subset). */
export interface ScheduleWire {
  id: string;
  prompt: string;
  scheduledAt: string;
  kind: string;
  state: "scheduled" | "overdue";
}

interface SessionLike {
  snapshotEvents?: () => Array<{ type?: unknown }>;
}

interface CordisLike {
  sessions?: { get?: (id: unknown) => SessionLike | undefined };
  sessionPersistence?: { inspect?: (id: unknown, signal?: AbortSignal) => Promise<{ events?: unknown }> };
}

/**
 * List active reminders for one session. Empty when the overlay is disabled
 * or the session has no reminders — the pill hides in both cases.
 */
export async function listSchedules(ctx: Context, sessionId: string): Promise<ScheduleWire[]> {
  const cordis = ctx as unknown as CordisLike;
  const stableId = SessionId(sessionId);
  let events: unknown;
  try {
    const live = cordis.sessions?.get?.(stableId);
    if (live && typeof live.snapshotEvents === "function") {
      events = live.snapshotEvents();
    } else {
      const inspection = await cordis.sessionPersistence?.inspect?.(stableId);
      events = inspection?.events ?? [];
    }
  } catch {
    return [];
  }
  if (!Array.isArray(events)) return [];
  try {
    const folded = foldScheduleEvents(events as never);
    const now = Date.now();
    return folded.active.map((record) => {
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
