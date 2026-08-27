"use client";

import React, { useEffect, useRef, useState } from "react";
import { Search, SearchX, FileText, Kanban, X, ArrowRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { revealNote, revealCard } from "@/lib/events";
import { Tooltip } from "@/components/ui/tooltip";
import { useCairnStore, type SearchResult } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import {
  filterSearchResults,
  resolveFocusedResult,
  clampFocus,
  mergeSemanticResults,
  type SearchFilterType,
} from "./search-utils";

interface ResultRowProps {
  result: SearchResult;
  focused: boolean;
  onSelect: (result: SearchResult) => void;
  globalIndex: number;
  focusedIndex: number;
  semanticScore?: number;
}

function ResultRow({ result, focused, onSelect, semanticScore }: ResultRowProps) {
  return (
    <button
      onClick={() => onSelect(result)}
      className={cn(
        "group relative flex items-center gap-3 w-full px-3 py-2.5 text-left transition-all",
        "border-l-[2px]",
        focused
          ? "bg-[var(--surface-2)] border-[var(--accent)]"
          : "border-transparent hover:bg-[var(--surface-2)] hover:border-[var(--border)]/50"
      )}
    >
      <span
        className={cn(
          "w-7 h-7 rounded-lg grid place-items-center border flex-shrink-0 transition-colors",
          result.type === "note"
            ? "bg-[color-mix(in_srgb,var(--info)_12%,transparent)] border-[color-mix(in_srgb,var(--info)_18%,transparent)] text-[var(--info)]"
            : "bg-[var(--accent-dim)] border-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-[var(--accent)]",
          focused && "ring-1 ring-[var(--accent)]/20"
        )}
      >
        {result.type === "note" ? <FileText size={12} /> : <Kanban size={12} />}
      </span>
      <span className="flex-1 min-w-0 text-left">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-[0.813rem] font-medium text-[var(--text-primary)] truncate tracking-tight">{result.title}</span>
          {semanticScore !== undefined && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[var(--accent-dim)] border border-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-[0.643rem] font-mono font-semibold text-[var(--accent)]" title={`Semantic: ${semanticScore.toFixed(2)}`}>
              <Sparkles size={9} />{Math.round(semanticScore * 100)}%
            </span>
          )}
        </span>
        <span className="flex items-center gap-1.5 mt-0.5 min-w-0">
          <span className="text-[0.714rem] px-1.5 py-0.5 rounded-full bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-tertiary)] truncate max-w-[14ch]">{result.projectName}</span>
          {result.snippet && <span className="text-[0.714rem] text-[var(--text-tertiary)] truncate flex-1 min-w-0">{result.snippet}</span>}
        </span>
      </span>
      <ArrowRight
        size={12}
        className={cn(
          "flex-shrink-0 transition-all",
          focused ? "opacity-100 text-[var(--accent)] translate-x-0" : "opacity-0 -translate-x-1 group-hover:opacity-60 group-hover:translate-x-0 text-[var(--text-tertiary)]"
        )}
      />
    </button>
  );
}

type FilterType = SearchFilterType;

const SEMANTIC_KEY = "search.semanticMode";

function loadSemanticPref(): boolean {
  try { return localStorage.getItem(SEMANTIC_KEY) === "1"; } catch { return false; }
}
function saveSemanticPref(v: boolean) {
  try { localStorage.setItem(SEMANTIC_KEY, v ? "1" : "0"); } catch { /* ignore */ }
}

interface SemanticHit {
  noteId: string;
  title: string;
  score: number;
  sectionTitle: string;
}

export function SearchPanel() {
  const { searchOpen, toggleSearch, searchAll, setView, setActiveProject, projects, activeWorkspaceId, notes } = useCairnStore(useShallow((s) => ({
    searchOpen:        s.searchOpen,
    toggleSearch:      s.toggleSearch,
    searchAll:         s.searchAll,
    setView:           s.setView,
    setActiveProject:  s.setActiveProject,
    projects:          s.projects,
    activeWorkspaceId: s.activeWorkspaceId,
    notes:             s.notes,
  })));
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [semanticScores, setSemanticScores] = useState<Map<string, number>>(new Map());
  const [focused, setFocused] = useState(0);
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [filterProject, setFilterProject] = useState<string | null>(null);
  const [semanticMode, setSemanticMode] = useState<boolean>(loadSemanticPref);
  const [embeddingsReady, setEmbeddingsReady] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef(notes);
  const projectsRef = useRef(projects);
  useEffect(() => { notesRef.current = notes; }, [notes]);
  useEffect(() => { projectsRef.current = projects; }, [projects]);

  const workspaceProjects = projects.filter((p) => p.workspaceId === activeWorkspaceId && !p.archivedAt);

  useEffect(() => {
    if (searchOpen) {
      queueMicrotask(() => {
        inputRef.current?.focus();
        setQuery("");
        setResults([]);
        setSemanticScores(new Map());
        setFocused(0);
        setFilterType("all");
        setFilterProject(null);
      });
    }
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const rt = window.electron?.runtime;
    if (!rt?.embeddings?.status) return;
    let cancelled = false;
    rt.embeddings.status()
      .then((st) => {
        if (cancelled) return;
        setEmbeddingsReady(Boolean(st.running && st.defaultModelId));
      })
      .catch(() => setEmbeddingsReady(false));
    return () => { cancelled = true; };
  }, [searchOpen]);

  function toggleSemantic() {
    setSemanticMode((prev) => {
      const next = !prev;
      saveSemanticPref(next);
      return next;
    });
  }

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const semanticTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (semanticTimer.current) clearTimeout(semanticTimer.current);
    if (query.trim().length < 1) {
      queueMicrotask(() => {
        setResults([]);
        setSemanticScores(new Map());
      });
      return;
    }
    const trimmed = query.trim();
    searchTimer.current = setTimeout(() => {
      setResults(searchAll(trimmed));
      setFocused(0);
    }, 150);

    if (semanticMode && embeddingsReady && activeWorkspaceId) {
      semanticTimer.current = setTimeout(async () => {
        const e = window.electron?.embeddings;
        if (!e?.search) return;
        const requestQuery = trimmed;
        try {
          const hits: SemanticHit[] = await e.search(activeWorkspaceId, requestQuery, { k: 20 });
          if (query.trim() !== requestQuery) return;
          const storeNotes = notesRef.current;
          const scoreMap = new Map<string, number>();
          const enriched: SearchResult[] = [];
          for (const h of hits) {
            const note = storeNotes.find((n) => n.id === h.noteId && !n.archivedAt);
            if (!note) continue;
            scoreMap.set(h.noteId, h.score);
            const project = projectsRef.current.find((p) => p.id === note.projectId);
            enriched.push({
              type: "note",
              id: note.id,
              title: note.title,
              snippet: h.sectionTitle ? `§ ${h.sectionTitle}` : "",
              projectId: note.projectId,
              projectName: project?.name ?? "",
            });
          }
          setSemanticScores(scoreMap);
          setResults((prevKeyword) => mergeSemanticResults(prevKeyword, enriched));
        } catch {
        }
      }, 250);
    } else {
      queueMicrotask(() => setSemanticScores(new Map()));
    }
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      if (semanticTimer.current) clearTimeout(semanticTimer.current);
    };
  }, [query, searchAll, semanticMode, embeddingsReady, activeWorkspaceId]);

  function handleSelect(result: SearchResult) {
    setActiveProject(result.projectId);
    if (result.type === "note") {
      revealNote(setView, result.id);
    } else {
      revealCard(setView, result.id);
    }
    toggleSearch();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    const total = noteResults.length + taskResults.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocused((f) => clampFocus(f + 1, total));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocused((f) => clampFocus(f - 1, total));
    } else if (e.key === "Enter") {
      const result = resolveFocusedResult(focused, noteResults, taskResults);
      if (result) handleSelect(result);
    }
  }

  useEscapeKey(toggleSearch, searchOpen);

  if (!searchOpen) return null;

  const filtered = filterSearchResults(results, filterType, filterProject);

  const noteResults = filtered.filter((r) => r.type === "note");
  const taskResults = filtered.filter((r) => r.type === "card");

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[10px]" onClick={toggleSearch} aria-hidden="true" />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search notes and tasks"
        className="relative w-full max-w-[640px] bg-[var(--surface)] border border-[var(--border)] rounded-2xl shadow-[0_24px_64px_rgba(0,0,0,.55),inset_0_1px_0_rgba(255,255,255,.04)] overflow-hidden animate-slide-in-up"
      >
        <div className="flex items-center gap-3 px-4 h-[52px] border-b border-[var(--border)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--surface-2)_60%,transparent),transparent)]">
          <span className="w-8 h-8 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] grid place-items-center text-[var(--text-tertiary)] flex-shrink-0">
            <Search size={14} />
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={semanticMode && embeddingsReady ? "Search notes and tasks — semantic…" : "Search notes and tasks…"}
            aria-label="Search notes and tasks"
            className="flex-1 bg-transparent text-[0.938rem] font-medium tracking-tight text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] placeholder:font-normal focus:outline-none"
          />
          {query && (
            <button onClick={() => setQuery("")} className="w-7 h-7 rounded-full bg-[var(--surface-2)] border border-[var(--border)] grid place-items-center text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:border-[var(--muted)] transition-colors flex-shrink-0" aria-label="Clear">
              <X size={12} />
            </button>
          )}
          <Tooltip content={embeddingsReady ? (semanticMode ? "Semantic search on — vectors" : "Enable semantic search") : "Enable embeddings in Settings to use semantic search"}>
            <span className={cn(!embeddingsReady && "cursor-not-allowed")}>
              <button
                type="button"
                onClick={toggleSemantic}
                disabled={!embeddingsReady}
                className={cn(
                  "flex items-center gap-1.5 h-7 px-2.5 rounded-full border text-[0.714rem] font-medium transition-colors",
                  semanticMode && embeddingsReady
                    ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)] shadow-sm"
                    : "border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:border-[var(--muted)]",
                  !embeddingsReady && "opacity-40 cursor-not-allowed"
                )}
              >
                <Sparkles size={11} /> <span className="hidden sm:inline">Semantic</span>
              </button>
            </span>
          </Tooltip>
          <span className="hidden sm:inline-flex items-center gap-1 text-[0.643rem] font-mono text-[var(--text-tertiary)] border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-1 rounded-md">
            ESC
          </span>
        </div>

        <div className="flex flex-col gap-2 px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface-2)]/30">
          <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="Filter by type">
            <span className="text-[0.643rem] font-semibold tracking-[0.06em] uppercase text-[var(--text-tertiary)] w-[52px] shrink-0 select-none">Type</span>
            {(["all", "notes", "tasks"] as FilterType[]).map((t) => (
              <button key={t} aria-pressed={filterType === t} onClick={() => { setFilterType(t); setFocused(0); }}
                className={cn("px-3 py-1 rounded-full text-xs font-medium border transition-all",
                  filterType === t
                    ? "bg-[var(--text-primary)] text-[var(--background)] border-[var(--text-primary)] shadow-sm"
                    : "bg-[var(--surface)] text-[var(--text-tertiary)] border-[var(--border)] hover:text-[var(--text-secondary)] hover:border-[var(--muted)]"
                )}>
                {t === "all" ? "All" : t === "notes" ? "Notes" : "Tasks"}
              </button>
            ))}
            <span className="ml-auto hidden sm:inline-flex text-[0.643rem] font-mono text-[var(--text-tertiary)]">
              {filtered.length} {filtered.length === 1 ? "result" : "results"}
            </span>
          </div>
          {workspaceProjects.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Filter by project">
              <span className="text-[0.643rem] font-semibold tracking-[0.06em] uppercase text-[var(--text-tertiary)] w-[52px] shrink-0 select-none">Project</span>
              {filterProject && (
                <button aria-pressed={!!filterProject} onClick={() => setFilterProject(null)} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]">
                  <X size={10} />
                  {workspaceProjects.find((p) => p.id === filterProject)?.name ?? "Project"}
                </button>
              )}
              {!filterProject && workspaceProjects.map((p) => (
                <button key={p.id} aria-pressed={filterProject === p.id} onClick={() => { setFilterProject(p.id); setFocused(0); }} className="px-2.5 py-1 rounded-full text-xs font-medium border border-[var(--border)] bg-[var(--surface)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:border-[var(--muted)] transition-colors truncate max-w-[120px]">
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="max-h-[420px] overflow-y-auto">
          {query && filtered.length === 0 && (
            <div className="px-6 py-10 text-center flex flex-col items-center gap-3">
              <span className="w-10 h-10 rounded-xl bg-[var(--surface-2)] border border-[var(--border)] grid place-items-center text-[var(--text-tertiary)]">
                <SearchX size={16} />
              </span>
              <p className="text-sm font-medium text-[var(--text-secondary)]">No results for “{query}”</p>
              <p className="text-xs text-[var(--text-tertiary)]">Try a different term or switch project filter</p>
            </div>
          )}

          {filtered.length > 0 && (
            <div className="py-2">
              {noteResults.length > 0 && (
                <>
                  <div className="px-4 py-2 flex items-center gap-2 text-[0.643rem] font-semibold tracking-[0.06em] uppercase text-[var(--text-tertiary)]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--info)]" /> Notes <span className="font-mono font-normal text-[var(--text-tertiary)]">· {noteResults.length}</span>
                  </div>
                  <div className="px-2 space-y-0.5 pb-2">
                    {noteResults.map((result, i) => (
                      <ResultRow key={result.id} result={result} focused={i === focused} onSelect={handleSelect} globalIndex={i} focusedIndex={focused} semanticScore={semanticScores.get(result.id)} />
                    ))}
                  </div>
                </>
              )}
              {taskResults.length > 0 && (
                <>
                  <div className="px-4 py-2 flex items-center gap-2 text-[0.643rem] font-semibold tracking-[0.06em] uppercase text-[var(--text-tertiary)] border-t border-[var(--border)] mt-2 pt-3">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" /> Tasks <span className="font-mono font-normal">· {taskResults.length}</span>
                  </div>
                  <div className="px-2 space-y-0.5">
                    {taskResults.map((result, i) => (
                      <ResultRow key={result.id} result={result} focused={noteResults.length + i === focused} onSelect={handleSelect} globalIndex={noteResults.length + i} focusedIndex={focused} />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {!query && (
            <div className="px-6 py-8 text-center">
              <div className="w-10 h-10 rounded-xl bg-[var(--surface-2)] border border-[var(--border)] grid place-items-center mx-auto text-[var(--text-tertiary)]">
                <Search size={16} />
              </div>
              <p className="text-sm font-medium text-[var(--text-secondary)] mt-3">Search across projects</p>
              <p className="text-xs text-[var(--text-tertiary)] mt-1 max-w-[32ch] mx-auto leading-relaxed">Notes, tasks, and semantic matches — filtered by type and project. Start typing.</p>
              <div className="flex items-center justify-center gap-3 mt-5 text-[0.714rem] text-[var(--text-tertiary)] font-mono">
                <span className="inline-flex items-center gap-1.5"><kbd className="bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-0.5">↑↓</kbd> navigate</span>
                <span className="inline-flex items-center gap-1.5"><kbd className="bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-0.5">↵</kbd> open</span>
                <span className="inline-flex items-center gap-1.5"><kbd className="bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-0.5">ESC</kbd> close</span>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 px-4 h-8 border-t border-[var(--border)] bg-[var(--surface-2)]/50 text-[0.643rem] font-mono text-[var(--text-tertiary)]">
          <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[var(--success)]" /> {results.length} hits</span>
          <span className="ml-auto hidden sm:inline-flex items-center gap-2">
            <span><kbd className="border border-[var(--border)] bg-[var(--surface)] px-1 rounded">↑↓</kbd> nav</span>
            <span><kbd className="border border-[var(--border)] bg-[var(--surface)] px-1 rounded">↵</kbd> open</span>
          </span>
        </div>
      </div>
    </div>
  );
}
