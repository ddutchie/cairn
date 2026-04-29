"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { Search, FileText, Kanban, X, ArrowRight } from "lucide-react";
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

export function SearchPanel() {
  const { searchOpen, toggleSearch, searchAll, setView, setActiveProject } = useCairnStore();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [focused, setFocused] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) {
      inputRef.current?.focus();
      setQuery("");
      setResults([]);
      setFocused(0);
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
      setFocused((f) => Math.min(f + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocused((f) => Math.max(f - 1, 0));
    } else if (e.key === "Enter" && results[focused]) {
      handleSelect(results[focused]);
    } else if (e.key === "Escape") {
      toggleSearch();
    }
  }

  if (!searchOpen) return null;

  const notes = results.filter((r) => r.type === "note");
  const tasks = results.filter((r) => r.type === "card");

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

        {/* Results */}
        <div className="max-h-96 overflow-y-auto">
          {query && results.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-[var(--text-tertiary)]">
              No results for &ldquo;{query}&rdquo;
            </div>
          )}

          {results.length > 0 && (
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
