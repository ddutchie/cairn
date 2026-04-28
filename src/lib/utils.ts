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

/** Strip HTML/TipTap content to plain text for search indexing. */
export function contentToText(content: object | null): string {
  if (!content) return "";
  try {
    const str = JSON.stringify(content);
    return str.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

export const PRIORITY_COLORS: Record<string, string> = {
  low: "text-stone-400",
  medium: "text-amber-400",
  high: "text-orange-400",
  urgent: "text-red-400",
};

export const STATUS_COLORS: Record<string, string> = {
  active: "text-emerald-400",
  on_hold: "text-amber-400",
  completed: "text-sky-400",
  archived: "text-stone-500",
};
