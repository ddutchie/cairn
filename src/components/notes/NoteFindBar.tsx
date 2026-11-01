"use client";
/* eslint-disable react-hooks/set-state-in-effect -- match count/index are read back from CodeMirror / the DOM */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X, CaseSensitive, WholeWord } from "lucide-react";
import type { EditorView } from "@codemirror/view";
import { cn } from "@/lib/utils";
import { findMatches } from "../../../shared/notes/search";
import { setFind } from "./note-find-extension";
import { IconButton } from "@/components/ui/icon-button";

const HL = "cairn-find";
const HL_CURRENT = "cairn-find-current";

// The CSS build can't parse ::highlight(), so the two rules are injected once at runtime.
const HL_STYLE_ID = "cairn-find-highlight-style";
function ensureHighlightStyle() {
  if (typeof document === "undefined" || document.getElementById(HL_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = HL_STYLE_ID;
  el.textContent = `::highlight(${HL}) { background-color: color-mix(in srgb, var(--accent) 24%, transparent); color: inherit; }
::highlight(${HL_CURRENT}) { background-color: color-mix(in srgb, var(--accent) 60%, transparent); color: inherit; }`;
  document.head.appendChild(el);
}

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
function highlights(): HighlightRegistry | null {
  return (typeof CSS !== "undefined" && (CSS as unknown as { highlights?: HighlightRegistry }).highlights) || null;
}
function clearReadHighlights() {
  const reg = highlights();
  reg?.delete(HL);
  reg?.delete(HL_CURRENT);
}

const READ_BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "FIELDSET", "FIGURE", "FOOTER", "FORM",
  "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
  "SECTION", "TABLE", "TD", "TH", "TR", "UL",
]);

function readBlock(node: Text, root: HTMLElement): Element {
  let el = node.parentElement;
  while (el && el !== root) {
    if (READ_BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return root;
}

/**
 * DOM ranges for every match inside `root`. Text is searched per rendered block
 * so a match can span inline elements (`hello **world**` finds "hello world").
 */
function collectReadRanges(root: HTMLElement, query: string, caseSensitive: boolean, wholeWord: boolean): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);

  for (let i = 0; i < nodes.length;) {
    const block = readBlock(nodes[i], root);
    const group: Text[] = [];
    while (i < nodes.length && readBlock(nodes[i], root) === block) group.push(nodes[i++]);
    const text = group.map((n) => n.nodeValue ?? "").join("");
    for (const m of findMatches(text, query, { caseSensitive, wholeWord })) {
      let offset = 0;
      let start: { node: Text; at: number } | null = null;
      let end: { node: Text; at: number } | null = null;
      for (const node of group) {
        const next = offset + (node.nodeValue ?? "").length;
        if (!start && m.from < next) start = { node, at: m.from - offset };
        if (m.to <= next) { end = { node, at: m.to - offset }; break; }
        offset = next;
      }
      if (!start || !end) continue;
      const r = document.createRange();
      r.setStart(start.node, start.at);
      r.setEnd(end.node, end.at);
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
      ensureHighlightStyle();
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
      className="absolute top-2 right-4 z-30 flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-1.5 py-1 shadow-elev-2"
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
          "w-44 bg-[var(--surface-2)] rounded px-2 py-1 text-sm text-[var(--text-primary)] outline-none border",
          noMatches ? "border-[var(--danger,var(--accent))]" : "border-transparent focus:border-[var(--accent)]",
        )}
      />
      <span className="min-w-[4.5ch] px-1 text-center text-xs tabular-nums text-[var(--text-tertiary)]" aria-live="polite">
        {!query ? "" : count === 0 ? "No results" : `${Math.min(current, count - 1) + 1}/${count}`}
      </span>
      <IconButton
        label="Match case" tooltipSide="top"
        aria-pressed={caseSensitive}
        onClick={() => { setCaseSensitive((v) => !v); setCurrent(0); scrollNext.current = true; }}
        className={cn("size-auto p-1 hover:bg-[var(--surface-2)]", caseSensitive ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)]")}
      ><CaseSensitive size={14} /></IconButton>
      <IconButton
        label="Whole word" tooltipSide="top"
        aria-pressed={wholeWord}
        onClick={() => { setWholeWord((v) => !v); setCurrent(0); scrollNext.current = true; }}
        className={cn("size-auto p-1 hover:bg-[var(--surface-2)]", wholeWord ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)]")}
      ><WholeWord size={14} /></IconButton>
      <IconButton
        label="Previous match" tooltip="Previous (⇧↵)" tooltipSide="top"
        onClick={() => step(-1)}
        disabled={count === 0}
        className="size-auto p-1 text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-40"
      ><ChevronUp size={14} /></IconButton>
      <IconButton
        label="Next match" tooltip="Next (↵)" tooltipSide="top"
        onClick={() => step(1)}
        disabled={count === 0}
        className="size-auto p-1 text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-40"
      ><ChevronDown size={14} /></IconButton>
      <IconButton
        label="Close find" tooltip="Close (Esc)" tooltipSide="top"
        onClick={onClose}
        className="size-auto p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]"
      ><X size={14} /></IconButton>
    </div>
  );
}
