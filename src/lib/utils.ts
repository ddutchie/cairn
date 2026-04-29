import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { nanoid } from "nanoid";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function id(): string {
  return nanoid(12);
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

export const PRIORITY_COLORS: Record<string, string> = {
  low: "text-stone-400",
  medium: "text-amber-400",
  high: "text-orange-400",
  urgent: "text-red-400",
};

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
  active: "text-emerald-400",
  on_hold: "text-amber-400",
  completed: "text-sky-400",
  archived: "text-stone-500",
};
