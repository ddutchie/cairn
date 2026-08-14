"use client";

/**
 * SyncStatusIndicator — the desktop title-bar sync glyph + popover.
 *
 * Mirrors mobile's SyncStatusBadge: a small icon button reflecting the live
 * sync state (idle / syncing / offline / pending / conflicts). Clicking opens a
 * popover with the last-sync summary, a "Sync now" button, and — when conflicts
 * exist — a shortcut to open the conflict-resolution modal.
 *
 * Rendered inside the title bar's drag region, so the button sets
 * WebkitAppRegion:"no-drag" to stay clickable.
 */

import { useEffect, useRef, useState } from "react";
import { CloudCheck, CloudOff, RefreshCw, CloudAlert, AlertTriangle } from "lucide-react";
import { useSyncStatus, triggerSyncNow, openConflictModal, type SyncState } from "@/lib/sync-client";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function glyph(state: SyncState, conflicts: number, pending: number) {
  if (conflicts > 0) return { Icon: CloudAlert, color: "var(--warning)", label: `${conflicts} sync conflict${conflicts === 1 ? "" : "s"}` };
  if (state === "offline") return { Icon: CloudOff, color: "var(--text-tertiary)", label: "Sync offline" };
  if (state === "disabled") return { Icon: CloudOff, color: "var(--text-tertiary)", label: "Sync not set up" };
  if (state === "syncing") return { Icon: RefreshCw, color: "var(--accent)", label: "Syncing…" };
  if (pending > 0) return { Icon: CloudAlert, color: "var(--warning)", label: `${pending} change${pending === 1 ? "" : "s"} pending` };
  return { Icon: CloudCheck, color: "var(--success)", label: "Synced" };
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function SyncStatusIndicator() {
  const status = useSyncStatus();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Bumped on a timer while the popover is open so the "Last synced" relative
  // time stays current between (sparse) status pushes instead of freezing.
  const [, setNowTick] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [open]);

  // Close the popover on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Render only when Device Sync is actually enabled (a folder is connected).
  // With no sync configured there is nothing to show in the title bar.
  if (!status.connected) return null;

  const { Icon, color, label } = glyph(status.state, status.conflicts, status.pending);
  const spinning = status.state === "syncing";

  const onSyncNow = async () => {
    setBusy(true);
    try {
      await triggerSyncNow();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <Tooltip side="bottom" content={label}>
        <button
          type="button"
          aria-label={label}
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 h-6 px-1.5 rounded-md hover:bg-[var(--surface-2)] transition-colors"
        >
          <Icon size={13} style={{ color }} className={cn(spinning && "animate-spin")} />
          {status.conflicts > 0 && (
            <span className="text-[0.65rem] font-semibold leading-none" style={{ color: "var(--warning)" }}>
              {status.conflicts}
            </span>
          )}
        </button>
      </Tooltip>

      {open && (
        <div
          className="absolute right-0 top-[110%] z-50 w-64 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-lg p-3 animate-fade-in"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <div className="flex items-center gap-2 mb-2">
            <Icon size={14} style={{ color }} className={cn(spinning && "animate-spin")} />
            <span className="text-xs font-semibold text-[var(--text-primary)]">{label}</span>
          </div>

          <dl className="space-y-1 text-[0.714rem] text-[var(--text-tertiary)]">
            <Row label="Last synced" value={relativeTime(status.lastSyncAt)} />
            <Row label="Pending changes" value={String(status.pending)} />
            <Row label="Conflicts" value={String(status.conflicts)} highlight={status.conflicts > 0} />
          </dl>

          {status.conflicts > 0 && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openConflictModal();
              }}
              className="mt-2 w-full flex items-center justify-center gap-1.5 h-7 rounded-md text-xs font-medium text-[var(--warning)] border border-[color-mix(in_srgb,var(--warning)_40%,transparent)] hover:bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] transition-colors"
            >
              <AlertTriangle size={12} />
              Review conflicts
            </button>
          )}

          <button
            type="button"
            onClick={onSyncNow}
            disabled={busy || status.state === "syncing" || !status.connected}
            className="mt-2 w-full flex items-center justify-center gap-1.5 h-7 rounded-md text-xs font-medium text-[var(--accent-fg)] bg-[var(--accent)] hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <RefreshCw size={12} className={cn((busy || status.state === "syncing") && "animate-spin")} />
            Sync now
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <dt>{label}</dt>
      <dd className={cn("font-medium", highlight ? "text-[var(--warning)]" : "text-[var(--text-secondary)]")}>{value}</dd>
    </div>
  );
}
