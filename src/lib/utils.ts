import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { nanoid } from "nanoid";
import { defaultUrlTransform } from "react-markdown";
export { PRIORITY_COLORS } from "./constants";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function id(): string {
  return nanoid(12);
}

/**
 * Defensive renderer-side fallback for tool-call chip labels. The main process
 * already emits friendly labels (e.g. "Canva · Search designs"), but a raw
 * namespaced id can still reach the UI via a transient "pending" chip or a
 * historical message saved before labelling existed. This strips the
 * `mcp__<id>__` / `svc__<id>__` prefix and prettifies the remaining tool name:
 *   "mcp__BZfTDDlqAOoB__search-designs" → "Search designs".
 * Anything that isn't a raw namespaced id is returned unchanged.
 */
export function prettifyToolLabel(label: string): string {
  if (typeof label !== "string") return label;
  // Only rewrite when it actually looks like a raw namespaced id with a tool part.
  const match = /^(?:mcp|svc)__.+?__(.+)$/.exec(label);
  if (!match || !match[1]) return label;
  const tool = match[1].replace(/[_.\-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!tool) return label;
  return tool.charAt(0).toUpperCase() + tool.slice(1);
}

export function now(): string {
  return new Date().toISOString();
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatRelative(iso: string): string {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(iso);
}

/**
 * Returns "overdue" | "today" | "upcoming" | "none" for a due date string.
 * Compares calendar days (not timestamps) so due-today is correct regardless of time.
 */
export function getDueDateStatus(dueDate: string | null | undefined): "overdue" | "today" | "upcoming" | "none" {
  if (!dueDate) return "none";
  const due = new Date(dueDate);
  const today = new Date();
  // Normalise both to midnight local time for day comparison
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  const diff = due.getTime() - today.getTime();
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  return "upcoming";
}

export const STATUS_COLORS: Record<string, string> = {
  active:    "text-[var(--success)]",
  on_hold:   "text-[var(--warning)]",
  completed: "text-[var(--info)]",
  archived:  "text-[var(--text-tertiary)]",
};

export function urlTransform(url: string): string {
  return url.startsWith("asset://")
    ? (typeof window !== "undefined" && !window.electron ? `/api/assets/${url.slice(8)}` : url)
    : defaultUrlTransform(url);
}
