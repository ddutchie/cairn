"use client";

/**
 * ConflictBanner — a strip under the title bar shown only when unresolved sync
 * conflicts exist. Mirrors mobile's ConflictBanner. Clicking opens the
 * resolution modal.
 */

import { AlertTriangle, ChevronRight } from "lucide-react";
import { useSyncStatus, openConflictModal } from "@/lib/sync-client";

export function ConflictBanner() {
  const { conflicts } = useSyncStatus();
  if (conflicts <= 0) return null;

  return (
    <button
      type="button"
      onClick={openConflictModal}
      className="flex items-center gap-2 w-full h-9 px-4 text-left border-b border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] hover:bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] transition-colors"
    >
      <AlertTriangle size={14} className="text-[var(--warning)] shrink-0" />
      <span className="text-xs font-medium text-[var(--text-primary)]">
        {conflicts} sync {conflicts === 1 ? "conflict" : "conflicts"} to review
      </span>
      <ChevronRight size={14} className="ml-auto text-[var(--warning)]" />
    </button>
  );
}
