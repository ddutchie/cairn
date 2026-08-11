"use client";

/**
 * ConflictResolutionModal — desktop equivalent of mobile's ConflictsScreen.
 *
 * Lists every conflict-copy note (the losing side of a 3-way body conflict the
 * sync engine kept rather than lost) with a side-by-side view of the current
 * note vs the conflicted copy, and three choices per conflict:
 *   • Keep current  — discard the copy.
 *   • Use copy      — overwrite the original with the copy's body.
 *   • Merge         — auto 3-way merge against the common ancestor when clean;
 *                     otherwise open an editable text box (never inject <<<<
 *                     conflict markers into the note).
 */

import { useCallback, useEffect, useState } from "react";
import { GitMerge, FileText, ArrowRight, Check, X, Pencil } from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { fetchConflicts, resolveConflict, type ConflictCopy } from "@/lib/sync-client";
import { merge3 } from "@/lib/merge3";
import { diffLines, diffStats } from "@/lib/line-diff";

export function ConflictResolutionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [conflicts, setConflicts] = useState<ConflictCopy[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Per-conflict merge editor state (id → draft text). Presence = editor open.
  const [mergeDraft, setMergeDraft] = useState<Record<string, string>>({});

  // `showSpinner` only on the initial open — background db:changed refetches
  // should update the list silently (no loading flicker).
  const refresh = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    setConflicts(await fetchConflicts());
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) void refresh(true);
  }, [open, refresh]);

  // While the modal is open, keep the list live: a background sync that mints a
  // new conflict copy (or a resolution on another window) fires db:changed, so
  // refetch rather than showing a stale list until reopen.
  useEffect(() => {
    if (!open || typeof window === "undefined" || !window.electron?.onDbChanged) return;
    const unsub = window.electron.onDbChanged(() => void refresh(false));
    return () => { unsub(); };
  }, [open, refresh]);

  const removeLocal = (copyId: string) => {
    setConflicts((prev) => prev.filter((c) => c.id !== copyId));
    setMergeDraft((prev) => {
      const next = { ...prev };
      delete next[copyId];
      return next;
    });
  };

  const onResolve = async (copyId: string, action: "keepCopy" | "keepOriginal") => {
    setBusyId(copyId);
    try {
      await resolveConflict(copyId, action);
      removeLocal(copyId);
    } finally {
      setBusyId(null);
    }
  };

  // Merge: auto-merge if clean, else open the manual editor pre-filled with the
  // best-effort merged text.
  const onMerge = (c: ConflictCopy) => {
    const ours = c.original?.content ?? "";
    const theirs = c.content ?? "";
    const result = merge3(c.baseBody, ours, theirs);
    if (result.clean) {
      void applyMerge(c.id, result.merged);
    } else {
      setMergeDraft((prev) => ({ ...prev, [c.id]: result.merged }));
    }
  };

  const applyMerge = async (copyId: string, mergedContent: string) => {
    setBusyId(copyId);
    try {
      await resolveConflict(copyId, "keepMerged", mergedContent);
      removeLocal(copyId);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      size="lg"
      scrollable
      title={
        <>
          <GitMerge size={15} className="text-[var(--warning)]" />
          Resolve sync conflicts
        </>
      }
      description="Review notes that were edited on two devices at once and choose which version to keep, or merge them."
    >
      {loading ? (
        <div className="py-12 text-center text-sm text-[var(--text-tertiary)]">Loading…</div>
      ) : conflicts.length === 0 ? (
        <div className="py-12 flex flex-col items-center gap-2 text-center">
          <GitMerge size={28} className="text-[var(--text-tertiary)] opacity-50" />
          <p className="text-sm font-medium text-[var(--text-secondary)]">No conflicts to resolve</p>
          <p className="text-[0.714rem] text-[var(--text-tertiary)] max-w-xs">
            When the same note is edited on two devices offline, the diverging copy is kept here so nothing is lost.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {conflicts.map((c) => {
            const editing = c.id in mergeDraft;
            return (
              <div key={c.id} className="rounded-xl border border-[var(--border)] overflow-hidden">
                <div className="px-3 py-2 bg-[var(--surface-2)] border-b border-[var(--border)] flex items-center gap-2">
                  <FileText size={13} className="text-[var(--text-tertiary)]" />
                  <span className="text-xs font-semibold text-[var(--text-primary)] truncate">{c.title}</span>
                  {c.deviceId && (
                    <span className="ml-auto text-[0.65rem] text-[var(--text-tertiary)]">from {c.deviceId}</span>
                  )}
                </div>

                {editing ? (
                  <div className="p-3 space-y-2">
                    <div className="flex items-center gap-1.5 text-[0.643rem] uppercase tracking-wide text-[var(--warning)]">
                      <Pencil size={11} />
                      Overlapping edits — review the merged result before saving
                    </div>
                    <textarea
                      value={mergeDraft[c.id]}
                      onChange={(e) => setMergeDraft((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      className="w-full h-48 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 text-[0.714rem] font-mono text-[var(--text-primary)] resize-y focus:outline-none focus:border-[var(--accent)]"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === c.id}
                        onClick={() =>
                          setMergeDraft((prev) => {
                            const next = { ...prev };
                            delete next[c.id];
                            return next;
                          })
                        }
                      >
                        <X size={12} className="mr-1.5" />
                        Cancel
                      </Button>
                      <Button
                        variant="default"
                        size="sm"
                        disabled={busyId === c.id}
                        onClick={() => applyMerge(c.id, mergeDraft[c.id])}
                      >
                        <Check size={12} className="mr-1.5" />
                        Save merged
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <DiffView
                      current={c.original ? (c.original.content ?? "") : ""}
                      copy={c.content ?? ""}
                      originalDeleted={!c.original}
                    />

                    <div className="px-3 py-2.5 border-t border-[var(--border)] flex items-center justify-end gap-2">
                      <Button variant="ghost" size="sm" disabled={busyId === c.id} onClick={() => onResolve(c.id, "keepOriginal")}>
                        Keep current
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busyId === c.id} onClick={() => onResolve(c.id, "keepCopy")}>
                        Use copy
                      </Button>
                      <Button variant="default" size="sm" disabled={busyId === c.id} onClick={() => onMerge(c)}>
                        <GitMerge size={12} className="mr-1.5" />
                        Merge
                        <ArrowRight size={12} className="ml-1.5" />
                      </Button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </ModalShell>
  );
}

/**
 * Unified line-diff of the current note vs the conflicted copy. Lines only in
 * the current note are shown red ("−"); lines only in the copy are shown green
 * ("+"); unchanged lines are dimmed. A summary counts the changes so you can
 * tell at a glance how much differs — replacing the old opaque side-by-side
 * plain-text blocks.
 */
function DiffView({ current, copy, originalDeleted }: { current: string; copy: string; originalDeleted: boolean }) {
  if (originalDeleted) {
    return (
      <div className="p-3">
        <div className="text-[0.643rem] uppercase tracking-wide text-[var(--text-tertiary)] mb-1.5">
          Original was deleted — this is the conflicted copy
        </div>
        <pre className="text-[0.714rem] text-[var(--text-secondary)] whitespace-pre-wrap break-words max-h-56 overflow-y-auto font-mono leading-relaxed">
          {copy.trim().length > 0 ? copy : <span className="italic text-[var(--text-tertiary)]">(empty)</span>}
        </pre>
      </div>
    );
  }

  const rows = diffLines(current, copy);
  const { added, removed } = diffStats(rows);
  const identical = added === 0 && removed === 0;

  return (
    <div>
      <div className="px-3 pt-2.5 pb-1.5 flex items-center gap-3 text-[0.643rem] uppercase tracking-wide">
        <span className="text-[var(--text-tertiary)]">Current vs conflicted copy</span>
        {identical ? (
          <span className="text-[var(--text-tertiary)]">identical body</span>
        ) : (
          <span className="ml-auto flex items-center gap-2 normal-case tracking-normal">
            {added > 0 && <span className="text-[var(--success)]">+{added} in copy</span>}
            {removed > 0 && <span className="text-[var(--danger)]">−{removed} in current</span>}
          </span>
        )}
      </div>
      <div className="px-1 pb-2 max-h-64 overflow-y-auto">
        {identical ? (
          <div className="px-2 py-3 text-[0.714rem] text-[var(--text-tertiary)] italic">
            Both versions have the same body — the conflict is in metadata only.
          </div>
        ) : (
          <pre className="text-[0.714rem] font-mono leading-relaxed whitespace-pre-wrap break-words m-0">
            {rows.map((row, i) => {
              const isAdd = row.op === "add";
              const isRemove = row.op === "remove";
              return (
                <div
                  key={i}
                  className="px-2"
                  style={
                    isAdd
                      ? { background: "color-mix(in srgb, var(--success) 12%, transparent)", color: "var(--text-primary)" }
                      : isRemove
                      ? { background: "color-mix(in srgb, var(--danger) 12%, transparent)", color: "var(--text-primary)" }
                      : { color: "var(--text-tertiary)" }
                  }
                >
                  <span
                    className="select-none inline-block w-3 opacity-70"
                    style={{ color: isAdd ? "var(--success)" : isRemove ? "var(--danger)" : "transparent" }}
                  >
                    {isAdd ? "+" : isRemove ? "−" : " "}
                  </span>
                  {row.text.length > 0 ? row.text : "\u00A0"}
                </div>
              );
            })}
          </pre>
        )}
      </div>
    </div>
  );
}
