"use client";

/**
 * ReindexModal — shown on app startup when embeddings were created with a
 * different model than the current default. Offers to reindex all notes.
 *
 * Triggered by checking embeddings:needsReindex IPC on mount. If embeddings
 * are disabled or all embeddings match the current model, the modal stays
 * hidden.
 */

import React, { useState, useEffect, useCallback } from "react";
import { Loader2, CheckCircle2, AlertTriangle, RefreshCw, X } from "lucide-react";
import { useCairnStore } from "@/store";

type Phase = "hidden" | "pending" | "running" | "done" | "error";

interface ProgressEvent {
  modelId: string;
  status: string;
  progress?: number;
  loaded?: number;
  total?: number;
  error?: string;
}

export function ReindexModal() {
  const [phase, setPhase] = useState<Phase>("hidden");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const electron = window.electron;
    if (!electron?.embeddings?.needsReindex) return;

    electron.embeddings.needsReindex().then((result) => {
      if (result.needed) {
        setPhase("pending");
      }
    }).catch(() => {
      // stay hidden on error
    });
  }, []);

  useEffect(() => {
    const electron = window.electron;
    if (!electron?.embeddings?.models?.onProgress) return;
    const unsub = electron.embeddings.models.onProgress((ev: ProgressEvent) => {
      if (ev.status === "progress" && typeof ev.loaded === "number" && typeof ev.total === "number") {
        setProgress({ done: ev.loaded, total: ev.total });
      } else if (ev.status === "done") {
        setPhase((prev) => (prev === "running" ? "done" : prev));
      } else if (ev.status === "error") {
        setError(ev.error ?? "Unknown error");
        setPhase("error");
      }
    });
    return () => { unsub(); };
  }, []);

  const handleReindex = useCallback(async () => {
    const electron = window.electron;
    if (!electron?.embeddings?.reindex) return;
    const state = useCairnStore.getState();
    const workspaceId = state.workspaces[0]?.id;
    if (!workspaceId) {
      setError("No active workspace");
      setPhase("error");
      return;
    }
    setPhase("running");
    setProgress({ done: 0, total: 0 });
    try {
      await electron.embeddings.reindex(workspaceId);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, []);

  const handleDismiss = useCallback(() => {
    setPhase("hidden");
  }, []);

  if (phase === "hidden") return null;

  const pct = progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : phase === "running" ? 0 : 100;

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center"
      style={{ background: "color-mix(in srgb, var(--background) 85%, transparent)", backdropFilter: "blur(8px)" }}
    >
      <div
        className="w-full max-w-md rounded-xl border border-[var(--border)] shadow-2xl overflow-hidden"
        style={{ background: "var(--surface)" }}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-[var(--border)]">
          <div className="flex items-start justify-between">
            <h2 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
              {phase === "done" ? (
                <CheckCircle2 size={18} className="text-[var(--success)]" />
              ) : phase === "error" ? (
                <AlertTriangle size={18} className="text-[var(--warning)]" />
              ) : phase === "running" ? (
                <Loader2 size={18} className="animate-spin text-[var(--accent)]" />
              ) : (
                <RefreshCw size={18} className="text-[var(--accent)]" />
              )}
              Embedding Model Updated
            </h2>
            {phase === "pending" && (
              <button
                onClick={handleDismiss}
                className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
                title="Remind me later"
              >
                <X size={16} />
              </button>
            )}
          </div>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            {phase === "pending" &&
              "The embedding model has changed. Your notes need to be re-indexed with the new model for semantic search to work correctly."}
            {phase === "running" &&
              "Re-indexing notes — please don't close the app."}
            {phase === "done" &&
              "All notes have been re-indexed successfully."}
            {phase === "error" &&
              "An error occurred during re-indexing. You can retry from Settings > Embeddings."}
          </p>
        </div>

        {/* Progress */}
        {(phase === "running" || phase === "done") && (
          <div className="px-6 py-4">
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--border)" }}>
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${pct}%`, background: "var(--accent)" }}
              />
            </div>
            {progress && progress.total > 0 && (
              <p className="text-[0.714rem] text-[var(--text-tertiary)] mt-2">
                {progress.done} / {progress.total} notes {phase === "running" ? "…" : ""}
              </p>
            )}
          </div>
        )}

        {/* Error */}
        {phase === "error" && error && (
          <div className="px-6 py-4">
            <div
              className="rounded-lg p-3 text-sm text-[var(--error)]"
              style={{ background: "color-mix(in srgb, var(--error) 10%, transparent)" }}
            >
              {error}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[var(--border)] flex justify-end gap-2">
          {phase === "pending" && (
            <>
              <button
                onClick={handleDismiss}
                className="px-4 py-2 rounded-lg text-sm font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                style={{ background: "var(--surface-2)" }}
              >
                Later
              </button>
              <button
                onClick={handleReindex}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors"
                style={{ background: "var(--accent)" }}
              >
                Reindex Now
              </button>
            </>
          )}
          {(phase === "done" || phase === "error") && (
            <button
              onClick={handleDismiss}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors"
              style={{ background: "var(--accent)" }}
            >
              Continue
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
