/**
 * What each in-flight automation run is doing right now (starting, or the
 * tool it last called with its arguments), so a view that opens mid-run can
 * show it without having seen the live events. Set from the runner's
 * `automation:run` events and cleared when the run finishes.
 */
import type { TodayRunActivity } from "../../shared/today/brief";

const activity = new Map<string, TodayRunActivity>();

export function noteRunActivity(automationId: string, event: string, payload: Record<string, unknown>): void {
  if (event === "started") activity.set(automationId, { tool: null });
  else if (event === "tool" && payload.status === "start" && typeof payload.tool === "string") {
    const args = payload.args && typeof payload.args === "object" ? payload.args as Record<string, unknown> : undefined;
    activity.set(automationId, { tool: payload.tool, label: payload.label as string | undefined, args });
  } else if (event === "finished") activity.delete(automationId);
}

export function currentRunActivity(automationId: string): TodayRunActivity | null {
  return activity.get(automationId) ?? null;
}
