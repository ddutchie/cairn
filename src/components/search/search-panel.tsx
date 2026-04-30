"use client";

import React, { useEffect, useRef, useState } from "react";
import { Search, SearchX, FileText, Kanban, X, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { CairnEvents } from "@/lib/events";
import { useCairnStore, type SearchResult } from "@/store";

interface ResultRowProps {
  result: SearchResult;
  focused: boolean;
  onSelect: (result: SearchResult) => void;
  globalIndex: number;
  focusedIndex: number;
}

function ResultRow({ result, focused, onSelect }: ResultRowProps) {
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
          <span className="text-[11px] text-[var(--text-tertiary)] flex-shrink-0">
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

export function SearchPanel() {
  const { searchOpen, toggleSearch, searchAll, setView, setActiveProject, projects, activeWorkspaceId } = useCairnStore();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [focused, setFocused] = useState(0);
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [filterProject, setFilterProject] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const workspaceProjects = projects.filter((p) => p.workspaceId === activeWorkspaceId && !p.archivedAt);

  useEffect(() => {
    if (searchOpen) {
      inputRef.current?.focus();
      setQuery("");
      setResults([]);
      setFocused(0);
      setFilterType("all");
      setFilterProject(null);
    }
  }, [searchOpen]);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (query.trim().length < 1) { setResults([]); return; }
    searchTimer.current = setTimeout(() => {
      setResults(searchAll(query));
      setFocused(0);
    }, 150);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [query, searchAll]);

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
      setFocused((f) => Math.min(f + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocused((f) => Math.max(f - 1, 0));
    } else if (e.key === "Enter" && filtered[focused]) {
      handleSelect(filtered[focused]);
    } else if (e.key === "Escape") {
      toggleSearch();
    }
  }

  if (!searchOpen) return null;

  const filtered = results
    .filter((r) => filterType === "all" || (filterType === "notes" ? r.type === "note" : r.type === "card"))
    .filter((r) => !filterProject || r.projectId === filterProject);

  const notes = filtered.filter((r) => r.type === "note");
  const tasks = filtered.filter((r) => r.type === "card");

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
            placeholder="Search notes and tasks…"
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
          <kbd className="text-[10px] text-[var(--text-tertiary)] bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-0.5 font-mono">
            ESC
          </kbd>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] flex-wrap">
          {(["all", "notes", "tasks"] as FilterType[]).map((t) => (
            <button key={t} onClick={() => { setFilterType(t); setFocused(0); }}
              className={cn("px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors",
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
                  className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]">
                  <X size={9} />
                  {workspaceProjects.find((p) => p.id === filterProject)?.name ?? "Project"}
                </button>
              )}
              {!filterProject && workspaceProjects.map((p) => (
                <button key={p.id} onClick={() => { setFilterProject(p.id); setFocused(0); }}
                  className="px-2 py-0.5 rounded-full text-[11px] border border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:border-[var(--border)] transition-colors truncate max-w-[100px]">
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
              {notes.length > 0 && (
                <>
                  <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Notes</div>
                  {notes.map((result, i) => (
                    <ResultRow
                      key={result.id}
                      result={result}
                      focused={i === focused}
                      onSelect={handleSelect}
                      globalIndex={i}
                      focusedIndex={focused}
                    />
                  ))}
                </>
              )}
              {tasks.length > 0 && (
                <>
                  <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Tasks</div>
                  {tasks.map((result, i) => (
                    <ResultRow
                      key={result.id}
                      result={result}
                      focused={notes.length + i === focused}
                      onSelect={handleSelect}
                      globalIndex={notes.length + i}
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
                  <kbd className="bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-0.5 font-mono text-[10px]">↑↓</kbd>
                  navigate
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-0.5 font-mono text-[10px]">↵</kbd>
                  open
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-0.5 font-mono text-[10px]">ESC</kbd>
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
