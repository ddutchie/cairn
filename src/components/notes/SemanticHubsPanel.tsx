"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Sparkles, ChevronRight, CornerDownRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface AdjacentNote {
  noteId: string;
  title: string;
  score: number;
}

interface Props {
  workspaceId: string | null;
  noteId: string;
  /** The live (debounced) markdown content of the active note. */
  content: string;
  className?: string;
  onSelectNote: (noteId: string) => void;
}

export function SemanticHubsPanel({ workspaceId, noteId, content, className, onSelectNote }: Props) {
  const [results, setResults] = useState<AdjacentNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    void (async () => {
      if (!window.electron?.embeddings) return;
      try {
        const cfg = await window.electron.embeddings.getSettings();
        setEnabled(!!cfg?.enabled);
      } catch {
        // ignore
      }
    })();
  }, []);

  const fetchAdjacent = useCallback(async () => {
    if (!workspaceId || !content || !enabled) {
      setResults([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const trimmed = content.trim();
      if (trimmed.length < 4) {
        setResults([]);
        return;
      }
      const api = window.electron?.embeddings;
      if (!api) {
        setResults([]);
        return;
      }
      const res = await api.search(workspaceId, trimmed, {
        queryNoteId: noteId,
        k: 5,
      });
      setResults(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, content, noteId, enabled]);

  useEffect(() => {
    const handle = setTimeout(() => {
      void fetchAdjacent();
    }, 200);
    return () => clearTimeout(handle);
  }, [fetchAdjacent]);

  if (!enabled) return null;

  return (
    <div className={cn("flex flex-col border-l border-[var(--border)] bg-[var(--surface)] overflow-hidden", className)}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-subtle)]">
        <Sparkles size={12} className="text-[var(--accent)]" />
        <span className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">Semantic Hubs</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="px-3 py-2 text-xs text-[var(--text-tertiary)] animate-pulse">Searching…</div>
        )}
        {!loading && error && (
          <div className="px-3 py-2 text-xs text-[var(--error)]">{error}</div>
        )}
        {!loading && !error && results.length === 0 && (
          <div className="px-3 py-2 text-xs text-[var(--text-tertiary)]">
            No similar notes found yet. Save your note and reindex from Settings → Embeddings.
          </div>
        )}
        {!loading && !error && results.map((r) => (
          <button
            key={r.noteId}
            onClick={() => onSelectNote(r.noteId)}
            className="w-full flex items-start gap-2 px-3 py-2 hover:bg-[var(--surface-2)] transition-colors text-left border-b border-[var(--border-subtle)]"
          >
            <CornerDownRight size={11} className="text-[var(--text-tertiary)] mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-[var(--text-primary)] truncate">{r.title || "Untitled"}</div>
              <div className="flex items-center gap-1.5 mt-1">
                <div className="flex-1 h-1 rounded-full bg-[var(--surface-3)] overflow-hidden">
                  <div
                    className="h-full bg-[var(--accent)] rounded-full transition-all"
                    style={{ width: `${Math.round(r.score * 100)}%` }}
                  />
                </div>
                <span className="text-[0.65rem] text-[var(--text-tertiary)] font-mono">{r.score.toFixed(2)}</span>
              </div>
            </div>
            <ChevronRight size={11} className="text-[var(--text-tertiary)] mt-0.5 flex-shrink-0" />
          </button>
        ))}
      </div>
    </div>
  );
}
