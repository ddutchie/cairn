/** Labels shared by the Today history rail and the looking-back banner. */

import { TODAY_KEEP_DAYS } from "../../../shared/today/history";

export const TODAY_KEEP_DAYS_LABEL = `${TODAY_KEEP_DAYS} days kept`;

/** "Fri 13 Nov" for a "YYYY-MM-DD" day. */
export function dayLabel(date: string): string {
  return new Date(`${date}T00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** "07:02" for an ISO time. */
export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
