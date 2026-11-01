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

import { useEffect, useState } from "react";
import { CloudCheck, CloudOff, RefreshCw, CloudAlert, AlertTriangle } from "lucide-react";
import { RefreshSpin } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { useSyncStatus, triggerSyncNow, openConflictModal, type SyncState } from "@/lib/sync-client";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn, formatRelative } from "@/lib/utils";

function glyph(state: SyncState, conflicts: number, pending: number) {
  if (conflicts > 0) return { Icon: CloudAlert, color: "var(--warning)", label: `${conflicts} sync conflict${conflicts === 1 ? "" : "s"}` };
  if (state === "offline") return { Icon: CloudOff, color: "var(--text-tertiary)", label: "Sync offline" };
  if (state === "disabled") return { Icon: CloudOff, color: "var(--text-tertiary)", label: "Sync not set up" };
  if (state === "syncing") return { Icon: RefreshCw, color: "var(--accent)", label: "Syncing…" };
  if (pending > 0) return { Icon: CloudAlert, color: "var(--warning)", label: `${pending} change${pending === 1 ? "" : "s"} pending` };
  return { Icon: CloudCheck, color: "var(--success)", label: "Synced" };
}

export function SyncStatusIndicator() {
  const status = useSyncStatus();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Bumped on a timer while the popover is open so the "Last synced" relative
  // time stays current between (sparse) status pushes instead of freezing.
  const [, setNowTick] = useState(0);

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [open]);

  // Render only when Device Sync is actually enabled (a folder is connected).
  // With no sync configured there is nothing to show in the title bar.
  if (!status.connected) return null;

  const { Icon, color, label } = glyph(status.state, status.conflicts, status.pending);
  const spinning = status.state === "syncing";
  const isSynced = status.connected && status.conflicts === 0 && status.pending === 0 && status.state !== "syncing" && status.state !== "offline" && status.state !== "disabled";
  const buttonColor = isSynced ? "var(--text-tertiary)" : color;

  const onSyncNow = async () => {
    setBusy(true);
    try {
      await triggerSyncNow();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton label={label} pressed={open} tooltipDisabled={open} className="relative" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <Icon size={13} style={{ color: buttonColor }} className={cn(spinning && "animate-spin")} />
          {status.conflicts > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-0.5 rounded-full bg-[var(--warning)] text-[var(--background)] text-2xs font-bold grid place-items-center leading-none border border-[var(--surface)]">
              {status.conflicts}
            </span>
          )}
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        aria-label="Sync status"
        align="end"
        className="w-64 p-3"
        // Over the title bar: opt out of the window drag region so clicks land.
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
          <div className="flex items-center gap-2 mb-2">
            <Icon size={14} style={{ color }} className={cn(spinning && "animate-spin")} />
            <span className="text-xs font-semibold text-[var(--text-primary)]">{label}</span>
          </div>

          <dl className="space-y-1 text-xs text-[var(--text-tertiary)]">
            <Row label="Last synced" value={formatRelative(status.lastSyncAt, { fallback: "never", absoluteAfterDays: Infinity })} />
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

          <Button
            type="button"
            variant="accent"
            size="md"
            className="w-full"
            onClick={onSyncNow}
            disabled={busy || status.state === "syncing" || !status.connected}
          >
            <RefreshSpin size={12} spinning={busy || status.state === "syncing"} />
            Sync now
          </Button>
      </PopoverContent>
    </Popover>
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
