"use client";

import React, { useEffect, useRef, useState } from "react";
import { Search, SearchX, FileText, Kanban, X, ArrowRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { CairnEvents } from "@/lib/events";
import { Tooltip } from "@/components/ui/tooltip";
import { useCairnStore, type SearchResult } from "@/store";
import { useShallow } from "zustand/react/shallow";

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
        "flex items-start gap-3 w-full px-4 py-3 text-left transition-colors",
        focused
          ? "bg-[var(--surface-2)]"
          : "hover:bg-[var(--surface-2)]"
      )}
    >
      <div className="flex-shrink-0 mt-0.5">
        {result.type === "note" ? (
          <FileText size={14} className="text-[var(--info)]" />
        ) : (
          <Kanban size={14} className="text-[var(--accent)]" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--text-primary)] truncate">
            {result.title}
          </span>
          {semanticScore !== undefined && (
            <span
              className="flex items-center gap-1 text-[0.6rem] font-mono text-[var(--accent)] flex-shrink-0"
              title={`Semantic similarity: ${semanticScore.toFixed(2)}`}
            >
              <Sparkles size={9} />
              {Math.round(semanticScore * 100)}%
            </span>
          )}
          <span className="text-[0.786rem] text-[var(--text-tertiary)] flex-shrink-0">
            in {result.projectName}
          </span>
        </div>
        {result.snippet && (
          <p className="text-xs text-[var(--text-tertiary)] mt-0.5 truncate">
            {result.snippet}
          </p>
        )}
      </div>
      <ArrowRight
        size={12}
        className={cn(
          "flex-shrink-0 mt-1 transition-opacity",
          focused ? "opacity-100 text-[var(--accent)]" : "opacity-0"
        )}
      />
    </button>
  );
}

type FilterType = "all" | "notes" | "tasks";

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

  const workspaceProjects = projects.filter((p) => p.workspaceId === activeWorkspaceId && !p.archivedAt);

  useEffect(() => {
    if (searchOpen) {
      inputRef.current?.focus();
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery("");
      setResults([]);
      setSemanticScores(new Map());
      setFocused(0);
      setFilterType("all");
      setFilterProject(null);
    }
  }, [searchOpen]);

  // Probe embeddings availability once per panel open (cheap IPC)
  useEffect(() => {
    if (!searchOpen) return;
    const e = window.electron?.embeddings;
    if (!e?.status) return;
    let cancelled = false;
    e.status()
      .then((st) => {
        if (cancelled) return;
        // Enable the toggle if embeddings are enabled, model installed, and at least one note is indexed
        setEmbeddingsReady(Boolean(st.installed && st.activeModelId));
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
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]);
      setSemanticScores(new Map());
      return;
    }
    const trimmed = query.trim();
    searchTimer.current = setTimeout(() => {
      setResults(searchAll(trimmed));
      setFocused(0);
    }, 150);

    // Semantic path — only when mode is on, embeddings ready, and we have a workspace
    if (semanticMode && embeddingsReady && activeWorkspaceId) {
      semanticTimer.current = setTimeout(async () => {
        const e = window.electron?.embeddings;
        if (!e?.search) return;
        // Capture the query at request time so we can discard stale responses
        // if the user types more before the async search resolves.
        const requestQuery = trimmed;
        try {
          const hits: SemanticHit[] = await e.search(activeWorkspaceId, requestQuery, { k: 20 });
          if (query.trim() !== requestQuery) return;
          const storeNotes = notes;
          const scoreMap = new Map<string, number>();
          const enriched: SearchResult[] = [];
          for (const h of hits) {
            const note = storeNotes.find((n) => n.id === h.noteId && !n.archivedAt);
            if (!note) continue;
            scoreMap.set(h.noteId, h.score);
            const project = projects.find((p) => p.id === note.projectId);
            enriched.push({
              type: "note",
              id: note.id,
              title: note.title,
              snippet: h.sectionTitle ? `§ ${h.sectionTitle}` : "",
              projectId: note.projectId,
              projectName: project?.name ?? "",
            });
          }
          // Merge: semantic hits that aren't already in keyword results get appended
          setSemanticScores(scoreMap);
          setResults((prevKeyword) => {
            const seen = new Set(prevKeyword.map((r) => r.id));
            const merged = [...prevKeyword];
            for (const s of enriched) {
              if (!seen.has(s.id)) merged.push(s);
            }
            return merged;
          });
        } catch {
          // embeddings worker may be down — silently fall back to keyword-only
        }
      }, 250);
    } else {
      setSemanticScores(new Map());
    }
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      if (semanticTimer.current) clearTimeout(semanticTimer.current);
    };
  }, [query, searchAll, semanticMode, embeddingsReady, activeWorkspaceId, notes, projects]);

  function handleSelect(result: SearchResult) {
    setActiveProject(result.projectId);
    if (result.type === "note") {
      setView("notes");
      window.dispatchEvent(CairnEvents.selectNote(result.id));
    } else {
      setView("board");
      window.dispatchEvent(CairnEvents.openCard(result.id));
    }
    toggleSearch();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocused((f) => Math.min(f + 1, (noteResults.length + taskResults.length) - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocused((f) => Math.max(f - 1, 0));
    } else if (e.key === "Enter") {
      // Focus order matches UI order: notes first, then tasks.
      if (focused < noteResults.length && noteResults[focused]) {
        handleSelect(noteResults[focused]);
      } else if (focused >= noteResults.length) {
        const taskIdx = focused - noteResults.length;
        if (taskResults[taskIdx]) handleSelect(taskResults[taskIdx]);
      }
    } else if (e.key === "Escape") {
      toggleSearch();
    }
  }

  if (!searchOpen) return null;

  const filtered = results
    .filter((r) => filterType === "all" || (filterType === "notes" ? r.type === "note" : r.type === "card"))
    .filter((r) => !filterProject || r.projectId === filterProject);

  const noteResults = filtered.filter((r) => r.type === "note");
  const taskResults = filtered.filter((r) => r.type === "card");

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={toggleSearch}
      />

      {/* Panel */}
      <div className="relative w-full max-w-2xl bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden animate-slide-in-up">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
          <Search size={16} className="text-[var(--text-tertiary)] flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={semanticMode && embeddingsReady ? "Search notes and tasks (semantic)…" : "Search notes and tasks…"}
            className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            >
              <X size={14} />
            </button>
          )}
          <Tooltip content={embeddingsReady ? (semanticMode ? "Semantic search on" : "Enable semantic search") : "Enable embeddings in Settings to use semantic search"}>
            <span className={cn(!embeddingsReady && "cursor-not-allowed")}>
              <button
                type="button"
                onClick={toggleSemantic}
                disabled={!embeddingsReady}
                className={cn(
                  "flex items-center justify-center w-7 h-7 rounded-md border transition-colors",
                  semanticMode && embeddingsReady
                    ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                    : "border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]",
                  !embeddingsReady && "opacity-40 cursor-not-allowed"
                )}
              >
                <Sparkles size={13} />
              </button>
            </span>
          </Tooltip>
          <kbd className="text-[0.714rem] text-[var(--text-tertiary)] bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-0.5 font-mono">
            ESC
          </kbd>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] flex-wrap">
          {(["all", "notes", "tasks"] as FilterType[]).map((t) => (
            <button key={t} onClick={() => { setFilterType(t); setFocused(0); }}
              className={cn("px-2.5 py-0.5 rounded-full text-[0.786rem] font-medium border transition-colors",
                filterType === t
                  ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                  : "border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              )}>
              {t === "all" ? "All" : t === "notes" ? "Notes" : "Tasks"}
            </button>
          ))}
          {workspaceProjects.length > 1 && (
            <div className="flex items-center gap-1 ml-auto flex-wrap">
              {filterProject && (
                <button onClick={() => setFilterProject(null)}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[0.786rem] border border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]">
                  <X size={9} />
                  {workspaceProjects.find((p) => p.id === filterProject)?.name ?? "Project"}
                </button>
              )}
              {!filterProject && workspaceProjects.map((p) => (
                <button key={p.id} onClick={() => { setFilterProject(p.id); setFocused(0); }}
                  className="px-2 py-0.5 rounded-full text-[0.786rem] border border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:border-[var(--border)] transition-colors truncate max-w-[100px]">
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto">
          {query && filtered.length === 0 && (
            <div className="px-4 py-8 text-center flex flex-col items-center gap-2">
              <SearchX size={20} className="text-[var(--text-tertiary)] opacity-40" />
              <p className="text-sm text-[var(--text-tertiary)]">No results for &ldquo;{query}&rdquo;</p>
            </div>
          )}

          {filtered.length > 0 && (
            <div className="py-1">
              {noteResults.length > 0 && (
                <>
                  <div className="px-4 py-1.5 text-[0.714rem] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Notes</div>
                  {noteResults.map((result, i) => (
                    <ResultRow
                      key={result.id}
                      result={result}
                      focused={i === focused}
                      onSelect={handleSelect}
                      globalIndex={i}
                      focusedIndex={focused}
                      semanticScore={semanticScores.get(result.id)}
                    />
                  ))}
                </>
              )}
              {taskResults.length > 0 && (
                <>
                  <div className="px-4 py-1.5 text-[0.714rem] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Tasks</div>
                  {taskResults.map((result, i) => (
                    <ResultRow
                      key={result.id}
                      result={result}
                      focused={noteResults.length + i === focused}
                      onSelect={handleSelect}
                      globalIndex={noteResults.length + i}
                      focusedIndex={focused}
                    />
                  ))}
                </>
              )}
            </div>
          )}

          {!query && (
            <div className="px-4 py-6 text-center">
              <p className="text-sm text-[var(--text-tertiary)]">
                Type to search notes and tasks across all projects
              </p>
              <div className="flex items-center justify-center gap-4 mt-4 text-xs text-[var(--text-tertiary)]">
                <span className="flex items-center gap-1">
                  <kbd className="bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-0.5 font-mono text-[0.714rem]">↑↓</kbd>
                  navigate
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-0.5 font-mono text-[0.714rem]">↵</kbd>
                  open
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-0.5 font-mono text-[0.714rem]">ESC</kbd>
                  close
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
