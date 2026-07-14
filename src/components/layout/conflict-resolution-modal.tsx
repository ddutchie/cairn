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

export function ConflictResolutionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [conflicts, setConflicts] = useState<ConflictCopy[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Per-conflict merge editor state (id → draft text). Presence = editor open.
  const [mergeDraft, setMergeDraft] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setConflicts(await fetchConflicts());
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) void refresh();
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
                    <div className="flex items-center gap-1.5 text-[0.65rem] uppercase tracking-wide text-[var(--warning)]">
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
                    <div className="grid grid-cols-2 divide-x divide-[var(--border)]">
                      <VersionBlock
                        heading="This device (current)"
                        body={c.original ? c.original.content : "(the original was deleted)"}
                      />
                      <VersionBlock heading="Conflicted copy" body={c.content} />
                    </div>

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

function VersionBlock({ heading, body }: { heading: string; body: string | null }) {
  return (
    <div className="p-3 min-w-0">
      <div className="text-[0.65rem] uppercase tracking-wide text-[var(--text-tertiary)] mb-1.5">{heading}</div>
      <pre className="text-[0.714rem] text-[var(--text-secondary)] whitespace-pre-wrap break-words max-h-40 overflow-y-auto font-sans leading-relaxed">
        {body && body.trim().length > 0 ? body : <span className="italic text-[var(--text-tertiary)]">(empty)</span>}
      </pre>
    </div>
  );
}
