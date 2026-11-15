/**
 * Number/date formatting helpers for the Usage view.
 */
import { formatCompactWithMillion } from "../../../shared/format/number";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 1_234_000 → "1.2M", 48_000 → "48K". */
export function fmtCompact(n: number): string {
  return formatCompactWithMillion(n);
}

/** Full thousands-separated token count. */
export function fmtFull(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString("en-US");
}

/** Epoch ms → "Aug 6, 4:57 PM" (matches the usage-history row style). */
export function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "PM" : "AM";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${h % 12 || 12}:${String(m).padStart(2, "0")} ${ap}`;
}

/** "2026-08-06" → "Aug 6". */
export function fmtDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return `${MONTHS[m - 1]} ${d}`;
}
