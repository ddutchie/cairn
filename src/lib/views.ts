/**
 * View helpers — tiny predicates over `AppUIState["activeView"]` (cleanup
 * Phase 7). Compares against the union type so a typo'd view id fails
 * type-check instead of silently never matching.
 */

import type { AppUIState } from "@/types";

export type AppView = AppUIState["activeView"];

/** True when the active view is one of the given candidates. */
export function isView(view: AppView | null | undefined, ...candidates: AppView[]): boolean {
  if (view == null) return false;
  return (candidates as readonly string[]).includes(view);
}
