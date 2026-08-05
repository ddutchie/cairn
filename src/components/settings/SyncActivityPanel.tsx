"use client";

/**
 * Sync visibility & recovery (plan §4 Phase 4).
 *
 * Two questions this answers, both of which used to be unanswerable:
 *   - "Why did my note vanish?"  → the reconcile decision log.
 *   - "Can I get it back?"       → one-tap restore for peer-deleted notes.
 *
 * Restore goes through the engine so the revival carries proof it observed the
 * delete; a plain un-delete would simply be re-deleted on the next exchange.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { History, RotateCcw, ChevronDown, ChevronRight, AlertTriangle, ArrowUpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { revealNote, revealCard } from "@/lib/events";
import {
  fetchSyncActivity,
  fetchRestorableNotes,
  restoreDeletedNote,
  repairNoteFile,
  fetchPeerProtocols,
  useSyncStatus,
  type SyncActivityEntry,
  type RestorableNote,
  type SyncOutcome,
  type RestoreRefusal,
  type PeerProtocol,
} from "@/lib/sync-client";

/** How many recoverable notes to show per page. */
const RESTORABLE_PAGE = 20;

/** Plain-English label + tone per reconcile outcome. */
const OUTCOME_META: Record<SyncOutcome, { label: string; token: string; hint: string }> = {
  applied: {
    label: "Applied",
    token: "var(--success)",
    hint: "The incoming change was accepted.",
  },
  "conflict-copy": {
    label: "Conflict copy",
    token: "var(--warning)",
    hint: "Both sides edited this — the local version was kept as a separate copy.",
  },
  "delete-won": {
    label: "Delete won",
    token: "var(--danger)",
    hint: "A deletion took precedence over an edit that hadn't seen it.",
  },
  "skipped-stale": {
    label: "Skipped",
    token: "var(--text-tertiary)",
    hint: "Older than what this device already had, so it was ignored.",
  },
};

/** Why a restore didn't happen, in words a user can act on. */
const REFUSAL_TEXT: Record<RestoreRefusal, string> = {
  missing: "That note is no longer in the database.",
  live: "That note is already restored.",
  shell: "This device never received the note's content, so there's nothing to bring back.",
  "conflict-copy": "This is a conflict copy — resolve it from the conflicts view instead.",
  orphaned: "Its project was deleted too. Restore the project first.",
  "self-deleted": "This device deleted that note, so it isn't offered for recovery.",
  "no-delete-record": "Sync has no record of that deletion, so it can't be undone from here.",
  "preserved-as-copy": "Your edit is kept as a conflict copy — resolve it from the conflicts view instead.",
};

/**
 * Notes whose row was restored but whose `.md` file could not be written.
 *
 * Persisted, because this is a real on-disk inconsistency the user has to fix:
 * the note exists in the app with no file behind it. Losing the warning on the
 * next refresh (or a remount) would leave that silently broken.
 */
const FILE_ERROR_KEY = "syncRestoreFileErrors";

type FileFailure = { id: string; title: string; error: string };

function loadFileFailures(): FileFailure[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(FILE_ERROR_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is FileFailure =>
        !!f && typeof (f as FileFailure).id === "string" && typeof (f as FileFailure).error === "string",
    );
  } catch {
    return [];
  }
}

function saveFileFailures(failures: FileFailure[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FILE_ERROR_KEY, JSON.stringify(failures));
  } catch {
    /* storage full / disabled — the in-memory list still renders this session */
  }
}

function refusalText(reason?: string): string {
  if (!reason) return "Couldn't restore that note.";
  return REFUSAL_TEXT[reason as RestoreRefusal] ?? reason;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Absolute timestamp for the tooltip, so the relative form is never the only truth. */
function absoluteTime(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : "";
}

/**
 * Device ids are opaque (`desktop_k3j4h5g61x2`). Name this device explicitly and
 * shorten peers, rather than showing a user a raw identifier.
 */
function deviceLabel(origin: string, isSelf: boolean): string {
  if (isSelf) return "this device";
  const trimmed = origin.replace(/^(desktop|mobile|ios|android)[_-]/i, "");
  const short = trimmed.length > 8 ? `${trimmed.slice(0, 8)}…` : trimmed;
  if (/^(mobile|ios|android)/i.test(origin)) return `your phone (${short})`;
  if (/^desktop/i.test(origin)) return `another desktop (${short})`;
  return `another device (${short})`;
}

/** Human label for the affected row: its title, else a generic entity name. */
function rowLabel(entry: SyncActivityEntry): string {
  if (entry.title) return entry.title;
  const singular = entry.entity.replace(/s$/, "").replace(/_/g, " ");
  return `a ${singular}`;
}

/** Re-render on an interval so "just now" doesn't get stuck on an open pane. */
function useTicker(active: boolean, ms = 60_000): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [active, ms]);
}

export function SyncActivityPanel() {
  const [activity, setActivity] = useState<SyncActivityEntry[]>([]);
  const [restorable, setRestorable] = useState<RestorableNote[]>([]);
  const [restorableTotal, setRestorableTotal] = useState(0);
  const [pageSize, setPageSize] = useState(RESTORABLE_PAGE);
  const [showLog, setShowLog] = useState(false);
  const [restoring, setRestoring] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [fileFailures, setFileFailures] = useState<FileFailure[]>(() => loadFileFailures());
  const [stalePeers, setStalePeers] = useState<PeerProtocol[]>([]);
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(true);
  const setView = useCairnStore((s) => s.setView);

  // Re-render periodically so relative times stay honest while the pane is open.
  useTicker(true);

  // Re-fetch whenever sync reports new work, so a deletion that lands while the
  // pane is open actually shows up — the whole point is visibility.
  const status = useSyncStatus();

  const load = useCallback(
    async () => Promise.all([fetchSyncActivity(50), fetchRestorableNotes(pageSize), fetchPeerProtocols()]),
    [pageSize],
  );

  const recordFileFailure = useCallback((failure: FileFailure) => {
    setFileFailures((prev) => {
      const next = [...prev.filter((f) => f.id !== failure.id), failure];
      saveFileFailures(next);
      return next;
    });
  }, []);

  const clearFileFailure = useCallback((id: string) => {
    setFileFailures((prev) => {
      const next = prev.filter((f) => f.id !== id);
      saveFileFailures(next);
      return next;
    });
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Fetch in an async closure (not directly in the effect body) so the writes
  // land after the await and are dropped if this unmounts mid-flight.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [acts, restores, peers] = await load();
      if (cancelled) return;
      setActivity(acts);
      setRestorable(restores.rows);
      setRestorableTotal(restores.total);
      setStalePeers(peers);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [load, status.lastSyncAt, status.pending]);

  const onRestore = async (id: string, title: string) => {
    setRestoring((prev) => new Set(prev).add(id));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const res = await restoreDeletedNote(id);
      if (!alive.current) return;
      if (!res.restored) {
        setErrors((prev) => ({ ...prev, [id]: refusalText(res.reason) }));
      } else if (res.fileError) {
        // The row came back but its file didn't. Record it durably: the note now
        // exists with no file behind it, and the row leaves the restorable list,
        // so this is the only remaining trace of the problem.
        recordFileFailure({ id, title, error: res.fileError });
      }
      const [acts, restores, peers] = await load();
      if (!alive.current) return;
      setActivity(acts);
      setRestorable(restores.rows);
      setRestorableTotal(restores.total);
      setStalePeers(peers);
    } finally {
      if (alive.current) {
        setRestoring((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }
  };

  const onRepair = async (failure: FileFailure) => {
    setRestoring((prev) => new Set(prev).add(failure.id));
    try {
      const res = await repairNoteFile(failure.id);
      if (!alive.current) return;
      if (res.repaired) {
        clearFileFailure(failure.id);
      } else {
        recordFileFailure({
          ...failure,
          error: res.fileError ?? refusalText(res.reason),
        });
      }
    } finally {
      if (alive.current) {
        setRestoring((prev) => {
          const next = new Set(prev);
          next.delete(failure.id);
          return next;
        });
      }
    }
  };

  // Only peers on a LOWER protocol version drive the "needs updating" banner;
  // a peer merely on a different version (e.g. ahead) is informational and must
  // not, on its own, keep the empty-state from showing.
  const behindPeers = stalePeers.filter((p) => p.behind);

  // Nothing recorded yet (fresh install, or sync never ran) — say so rather
  // than rendering an empty shell.
  if (
    loaded &&
    activity.length === 0 &&
    restorable.length === 0 &&
    fileFailures.length === 0 &&
    behindPeers.length === 0
  ) {
    return (
      <p className="text-[0.714rem] text-[var(--text-tertiary)] mt-4">
        No sync activity recorded yet. Once this device exchanges changes with your phone, decisions
        show up here.
      </p>
    );
  }

  return (
    <div className="mt-4 space-y-3">
      {behindPeers.length > 0 && (
        <div className="flex gap-2.5 p-3 rounded-xl border border-[color-mix(in_srgb,var(--warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)]">
          <ArrowUpCircle size={15} className="text-[var(--warning)] mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-[var(--text-primary)]">
              {behindPeers.length === 1
                ? "Another device is on an older version"
                : `${behindPeers.length} devices are on an older version`}
            </div>
            <p className="text-[0.714rem] text-[var(--text-tertiary)] mt-0.5">
              Update Cairn on your other {behindPeers.length === 1 ? "device" : "devices"} so deletions
              sync correctly. Until then, a note you delete here can reappear from the older device.
            </p>
          </div>
        </div>
      )}
      {/* Rendered independently of the restorable list: once the row is live it
          leaves that list, but the missing file still needs fixing. */}
      {fileFailures.length > 0 && (
        <div className="p-3 rounded-xl border border-[color-mix(in_srgb,var(--warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] space-y-2">
          <div className="text-xs font-semibold text-[var(--text-primary)]">
            {fileFailures.length === 1
              ? "1 restored note has no file on disk"
              : `${fileFailures.length} restored notes have no file on disk`}
          </div>
          <p className="text-[0.714rem] text-[var(--text-tertiary)]">
            The note was restored in Cairn, but writing its Markdown file failed. Retry to write it
            again.
          </p>
          <ul className="space-y-1.5">
            {fileFailures.map((failure) => (
              <li key={failure.id} className="p-2 rounded-lg bg-[var(--surface-3)]">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[0.786rem] text-[var(--text-primary)] truncate">
                      {failure.title || "Untitled"}
                    </div>
                    <div className="text-[0.643rem] text-[var(--danger)] break-words">
                      {failure.error}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={restoring.has(failure.id)}
                    onClick={() => onRepair(failure)}
                  >
                    <RotateCcw
                      size={12}
                      className={cn("mr-1.5", restoring.has(failure.id) && "animate-spin")}
                    />
                    Retry
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {restorable.length > 0 && (
        <div className="p-3 rounded-xl border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_6%,transparent)] space-y-2">
          <div className="text-xs font-semibold text-[var(--text-primary)]">
            {restorableTotal === 1
              ? "1 note was deleted on another device"
              : `${restorableTotal} notes were deleted on another device`}
          </div>
          <p className="text-[0.714rem] text-[var(--text-tertiary)]">
            Restoring brings the note back everywhere — it won&apos;t be deleted again on the next
            sync.
          </p>
          <ul className="space-y-1.5">
            {restorable.map((note) => (
              <li key={note.entity_id} className="p-2 rounded-lg bg-[var(--surface-3)]">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[0.786rem] text-[var(--text-primary)] truncate">
                      {note.title || "Untitled"}
                    </div>
                    <div className="text-[0.643rem] text-[var(--text-tertiary)]">
                      deleted{" "}
                      <span title={note.deleted_at ? absoluteTime(note.deleted_at) : undefined}>
                        {note.deleted_at ? relativeTime(note.deleted_at) : "recently"}
                      </span>
                      {note.delete_origin ? ` on ${deviceLabel(note.delete_origin, false)}` : ""}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={restoring.has(note.entity_id)}
                    onClick={() => onRestore(note.entity_id, note.title ?? "Untitled")}
                  >
                    <RotateCcw
                      size={12}
                      className={cn("mr-1.5", restoring.has(note.entity_id) && "animate-spin")}
                    />
                    Restore
                  </Button>
                </div>
                {errors[note.entity_id] && (
                  <div className="flex items-start gap-1.5 mt-1.5 text-[0.643rem] text-[var(--danger)]">
                    <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                    <span>{errors[note.entity_id]}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {restorableTotal > restorable.length && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.643rem] text-[var(--text-tertiary)]">
                Showing {restorable.length} of {restorableTotal}.
              </span>
              {/* Without this the remaining notes are unreachable — restore is
                  per-row, so a count alone is a dead end. */}
              <button
                type="button"
                onClick={() => setPageSize((n) => n + RESTORABLE_PAGE)}
                className="text-[0.643rem] font-medium text-[var(--accent)] hover:underline"
              >
                Show more
              </button>
            </div>
          )}
        </div>
      )}

      {activity.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            aria-expanded={showLog}
            className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors"
          >
            {showLog ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <History size={13} className="text-[var(--accent)]" />
            Sync activity
          </button>

          {showLog && (
            <ul className="mt-2 space-y-1 max-h-64 overflow-y-auto">
              {activity.map((entry) => {
                // Tolerate an outcome written by a different build rather than
                // crashing the whole settings pane on an unknown key.
                const meta = OUTCOME_META[entry.outcome] ?? {
                  label: entry.outcome,
                  token: "var(--text-tertiary)",
                  hint: "",
                };
                // Only offer navigation when the row still exists (title
                // resolved) and we know how to reach that entity.
                const target =
                  entry.title && entry.entity === "notes"
                    ? () => revealNote(setView, entry.entity_id)
                    : entry.title && entry.entity === "task_cards"
                      ? () => revealCard(setView, entry.entity_id)
                      : null;
                const copyNote =
                  entry.conflict_side === "remote"
                    ? " · their edit kept as a copy"
                    : entry.conflict_side === "local"
                      ? " · your version kept as a copy"
                      : "";
                return (
                  <li key={entry.seq} className="rounded-lg bg-[var(--surface-3)]">
                    <div className="flex items-start gap-2 p-2">
                      <span
                        className="mt-0.5 shrink-0 px-1.5 py-0.5 rounded text-[0.607rem] font-semibold uppercase tracking-wide"
                        style={{
                          color: meta.token,
                          background: `color-mix(in srgb, ${meta.token} 14%, transparent)`,
                        }}
                        title={meta.hint}
                      >
                        {meta.label}
                      </span>
                      <div className="min-w-0 flex-1">
                        {target ? (
                          <button
                            type="button"
                            onClick={target}
                            className="block max-w-full text-left text-[0.714rem] text-[var(--text-secondary)] truncate hover:text-[var(--accent)] hover:underline transition-colors"
                          >
                            {entry.op === "delete" ? "Deleted" : "Changed"} {rowLabel(entry)}
                          </button>
                        ) : (
                          <div className="text-[0.714rem] text-[var(--text-secondary)] truncate">
                            {entry.op === "delete" ? "Deleted" : "Changed"} {rowLabel(entry)}
                          </div>
                        )}
                        <div className="text-[0.643rem] text-[var(--text-tertiary)]">
                          from {deviceLabel(entry.origin, entry.isSelf)} ·{" "}
                          <span title={absoluteTime(entry.at)}>seen {relativeTime(entry.at)}</span>
                          {copyNote}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
