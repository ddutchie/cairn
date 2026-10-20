"use client";
/* eslint-disable react-hooks/set-state-in-effect -- match count/index are read back from CodeMirror / the DOM */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X, CaseSensitive, WholeWord } from "lucide-react";
import type { EditorView } from "@codemirror/view";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { findMatches } from "../../../shared/notes/search";
import { setFind } from "./note-find-extension";

const HL = "cairn-find";
const HL_CURRENT = "cairn-find-current";

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
function highlights(): HighlightRegistry | null {
  return (typeof CSS !== "undefined" && (CSS as unknown as { highlights?: HighlightRegistry }).highlights) || null;
}
function clearReadHighlights() {
  const reg = highlights();
  reg?.delete(HL);
  reg?.delete(HL_CURRENT);
}

/** DOM ranges for every match inside `root`'s text nodes (matches never span elements). */
function collectReadRanges(root: HTMLElement, query: string, caseSensitive: boolean, wholeWord: boolean): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue ?? "";
    if (!text.trim()) continue;
    for (const m of findMatches(text, query, { caseSensitive, wholeWord })) {
      const r = document.createRange();
      r.setStart(n, m.from);
      r.setEnd(n, m.to);
      ranges.push(r);
    }
  }
  return ranges;
}

export interface NoteFindBarProps {
  /** Prefilled query (e.g. from a global search result). */
  initialQuery: string;
  /** Bumps when the bar is re-requested while open, so the input refocuses/refills. */
  requestId: number;
  mode: "edit" | "read";
  /** Note source — re-runs the search when it changes. */
  content: string;
  getView: () => EditorView | null;
  getReadRoot: () => HTMLElement | null;
  onClose: () => void;
}

export function NoteFindBar({ initialQuery, requestId, mode, content, getView, getReadRoot, onClose }: NoteFindBarProps) {
  const [query, setQuery] = useState(initialQuery);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [current, setCurrent] = useState(0);
  const [count, setCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Scroll only for user-driven moves, not for re-runs caused by typing in the note.
  const scrollNext = useRef(true);

  useEffect(() => {
    if (initialQuery) { setQuery(initialQuery); setCurrent(0); scrollNext.current = true; }
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [requestId, initialQuery]);

  useEffect(() => {
    const scroll = scrollNext.current;
    scrollNext.current = false;
    if (mode === "edit") {
      const view = getView();
      if (!view) return;
      if (!query) { setFind(view, null); setCount(0); return; }
      const r = setFind(view, { query, opts: { caseSensitive, wholeWord }, current }, scroll);
      setCount(r.count);
      if (r.current !== current) setCurrent(r.current);
      return () => { setFind(view, null, false); };
    }
    const root = getReadRoot();
    const reg = highlights();
    if (!root || !query) { clearReadHighlights(); setCount(0); return; }
    const ranges = collectReadRanges(root, query, caseSensitive, wholeWord);
    setCount(ranges.length);
    if (ranges.length === 0) { clearReadHighlights(); return; }
    const idx = Math.min(current, ranges.length - 1);
    if (reg) {
      const Hl = (window as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
      reg.set(HL, new Hl(...ranges));
      reg.set(HL_CURRENT, new Hl(ranges[idx]));
    }
    if (scroll) ranges[idx].startContainer.parentElement?.scrollIntoView({ block: "center" });
    return clearReadHighlights;
    // getView/getReadRoot are stable ref readers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, wholeWord, current, mode, content]);

  // Closing must clear highlights even if the effect cleanup raced a mode switch.
  useEffect(() => () => {
    clearReadHighlights();
    const v = getView();
    if (v) setFind(v, null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const step = useCallback((dir: 1 | -1) => {
    if (count === 0) return;
    scrollNext.current = true;
    setCurrent((c) => (c + dir + count) % count);
  }, [count]);

  const noMatches = query.length > 0 && count === 0;

  return (
    <div
      data-note-find
      className="absolute top-2 right-4 z-30 flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-1.5 py-1 shadow-lg"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => { setQuery(e.target.value); setCurrent(0); scrollNext.current = true; }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
          else if (e.key === "Escape") { e.preventDefault(); onClose(); }
        }}
        placeholder="Find in note"
        aria-label="Find in note"
        spellCheck={false}
        className={cn(
          "w-44 bg-[var(--surface-2)] rounded px-2 py-1 text-[0.786rem] text-[var(--text-primary)] outline-none border",
          noMatches ? "border-[var(--danger,var(--accent))]" : "border-transparent focus:border-[var(--accent)]",
        )}
      />
      <span className="min-w-[4.5ch] px-1 text-center text-[0.714rem] tabular-nums text-[var(--text-tertiary)]" aria-live="polite">
        {!query ? "" : count === 0 ? "No results" : `${Math.min(current, count - 1) + 1}/${count}`}
      </span>
      <Tooltip content="Match case">
        <button
          type="button"
          aria-label="Match case"
          aria-pressed={caseSensitive}
          onClick={() => { setCaseSensitive((v) => !v); setCurrent(0); scrollNext.current = true; }}
          className={cn("p-1 rounded hover:bg-[var(--surface-2)]", caseSensitive ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)]")}
        ><CaseSensitive size={14} /></button>
      </Tooltip>
      <Tooltip content="Whole word">
        <button
          type="button"
          aria-label="Whole word"
          aria-pressed={wholeWord}
          onClick={() => { setWholeWord((v) => !v); setCurrent(0); scrollNext.current = true; }}
          className={cn("p-1 rounded hover:bg-[var(--surface-2)]", wholeWord ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)]")}
        ><WholeWord size={14} /></button>
      </Tooltip>
      <Tooltip content="Previous (⇧↵)">
        <button type="button" aria-label="Previous match" onClick={() => step(-1)} disabled={count === 0}
          className="p-1 rounded text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-40"><ChevronUp size={14} /></button>
      </Tooltip>
      <Tooltip content="Next (↵)">
        <button type="button" aria-label="Next match" onClick={() => step(1)} disabled={count === 0}
          className="p-1 rounded text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-40"><ChevronDown size={14} /></button>
      </Tooltip>
      <Tooltip content="Close (Esc)">
        <button type="button" aria-label="Close find" onClick={onClose}
          className="p-1 rounded text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]"><X size={14} /></button>
      </Tooltip>
    </div>
  );
}
