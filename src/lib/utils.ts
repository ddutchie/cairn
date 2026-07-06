import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { nanoid } from "nanoid";
import { defaultUrlTransform } from "react-markdown";
export { PRIORITY_COLORS, STATUS_COLORS } from "./constants";
// Date formatters + tool-label prettifier now live in @cairn/shared so desktop
// and mobile share one implementation. Re-exported here to preserve the
// existing `@/lib/utils` import surface across the renderer.
export {
  formatDate,
  formatDateCompact,
  formatRelative,
  getDueDateStatus,
  type DueDateStatus,
} from "../../shared/format/date";
export { prettifyToolLabel } from "../../shared/ui/constants";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function id(): string {
  return nanoid(12);
}

export function now(): string {
  return new Date().toISOString();
}

/**
 * Canonical dark-mode read. The active theme is stored as the `data-theme`
 * attribute on `<html>` (set by `applyTheme`). Any value other than "light"
 * is treated as dark, and SSR / pre-hydration defaults to dark to match the
 * app's default theme. This is the single source of truth for imperative
 * reads (canvas draw, CodeMirror/mermaid theming); React components that need
 * to re-render on theme change should use the `useIsDark()` hook instead.
 */
export function getIsDark(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement.getAttribute("data-theme") !== "light";
}

export function urlTransform(url: string): string {
  return url.startsWith("asset://")
    ? (typeof window !== "undefined" && !window.electron ? `/api/assets/${url.slice(8)}` : url)
    : defaultUrlTransform(url);
}
