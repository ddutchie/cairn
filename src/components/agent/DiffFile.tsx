"use client";

/**
 * DiffFile — sub-components for DiffViewer: palette, syntax highlighting,
 * UnifiedFile, SplitFile, and FileDiff (collapsible file section).
 */

import React, { useMemo, useState, useEffect, useRef } from "react";
import type { File, Change } from "parse-diff";
import { common, createLowlight } from "lowlight";
import { ChevronRight, ChevronDown } from "lucide-react";

const lowlight = createLowlight(common);

// ── Palette ───────────────────────────────────────────────────────────────────

export type Palette = Record<string, string>;

export const PALETTE_DARK: Palette = {
  "hljs-keyword": "#c678dd", "hljs-built_in": "#e5c07b", "hljs-literal": "#56b6c2",
  "hljs-number": "#d19a66", "hljs-string": "#98c379", "hljs-comment": "#5c6370",
  "hljs-variable": "#e06c75", "hljs-attr": "#e06c75", "hljs-title": "#61afef",
  "hljs-type": "#e5c07b", "hljs-operator": "#56b6c2", "hljs-punctuation": "#abb2bf",
  "hljs-tag": "#e06c75", "hljs-meta": "#61afef",
  "hljs-addition": "#98c379", "hljs-deletion": "#e06c75",
};

export const PALETTE_LIGHT: Palette = {
  "hljs-keyword": "#7c3aed", "hljs-built_in": "#b45309", "hljs-literal": "#0891b2",
  "hljs-number": "#c2410c", "hljs-string": "#16a34a", "hljs-comment": "#9ca3af",
  "hljs-variable": "#dc2626", "hljs-attr": "#dc2626", "hljs-title": "#1d4ed8",
  "hljs-type": "#b45309", "hljs-operator": "#0891b2", "hljs-punctuation": "#374151",
  "hljs-tag": "#dc2626", "hljs-meta": "#1d4ed8",
  "hljs-addition": "#16a34a", "hljs-deletion": "#dc2626",
};

// ── Hast renderer ─────────────────────────────────────────────────────────────

interface HastNode {
  type: string; value?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
}

function renderHast(node: HastNode, palette: Palette, key: string): React.ReactNode {
  if (node.type === "text") return node.value ?? "";
  if (node.type === "element") {
    const colour = (node.properties?.className ?? []).map((c) => palette[c]).find(Boolean);
    const children = node.children?.map((ch, i) => renderHast(ch, palette, `${key}-${i}`));
    return colour ? <span key={key} style={{ color: colour }}>{children}</span> : <span key={key}>{children}</span>;
  }
  return null;
}

// ── Language detection ────────────────────────────────────────────────────────

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  c: "c", cpp: "cpp", cs: "csharp", json: "json", yaml: "yaml", yml: "yaml",
  sh: "bash", bash: "bash", md: "markdown", css: "css", html: "html",
  sql: "sql", swift: "swift", kt: "kotlin",
};

function langFrom(filename: string): string | null {
  return EXT_LANG[filename.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

// ── Highlighted line ──────────────────────────────────────────────────────────

function HL({ content, lang, palette }: { content: string; lang: string | null; palette: Palette }) {
  const tokens = useMemo(() => {
    if (!lang || !content) return null;
    try {
      if (!lowlight.listLanguages().includes(lang)) return null;
      return lowlight.highlight(lang, content).children as HastNode[];
    } catch { return null; }
  }, [content, lang]);
  return (
    <code className="font-mono text-[0.8rem] whitespace-pre">
      {tokens ? tokens.map((n, i) => renderHast(n, palette, String(i))) : content}
    </code>
  );
}

// ── View mode type ────────────────────────────────────────────────────────────

export type ViewMode = "unified" | "split" | "changes";

// ── Line number helper ────────────────────────────────────────────────────────

function ln(change: Change, side: "old" | "new"): number | "" {
  if (!("ln" in change) && !("ln1" in change) && !("ln2" in change)) return "";
  if (change.type === "normal") {
    return side === "old"
      ? ("ln1" in change ? (change as { ln1: number }).ln1 : "")
      : ("ln2" in change ? (change as { ln2: number }).ln2 : "");
  }
  if (change.type === "del") return side === "old" ? ((change as { ln?: number }).ln ?? "") : "";
  if (change.type === "add") return side === "new" ? ((change as { ln?: number }).ln ?? "") : "";
  return "";
}

// ── Unified file view ─────────────────────────────────────────────────────────

export function UnifiedFile({ file, palette, changesOnly, hunkTop }: { file: File; palette: Palette; changesOnly: boolean; hunkTop: number }) {
  const filename = file.to ?? file.from ?? "unknown";
  const lang = langFrom(filename);
  return (
    <>
      {file.chunks.map((chunk, ci) => {
        const rows = changesOnly
          ? chunk.changes.filter((c) => c.type !== "normal")
          : chunk.changes;
        if (rows.length === 0) return null;
        return (
          <div key={ci}>
            {!changesOnly && (
              <div
                className="px-3 py-0.5 text-[0.714rem] text-[var(--text-tertiary)] bg-[var(--surface)] font-mono border-b border-[var(--border-subtle)] sticky z-[9]"
                style={{ top: hunkTop }}
              >
                {chunk.content}
              </div>
            )}
            {rows.map((change, li) => {
              const isAdd = change.type === "add";
              const isDel = change.type === "del";
              const content = change.content.slice(1);
              const sigil = change.content[0];
              const addColor = palette["hljs-addition"];
              const delColor = palette["hljs-deletion"];
              return (
                <div
                  key={li}
                  className="flex font-mono text-[0.8rem] leading-relaxed"
                  style={{
                    background: isAdd
                      ? "color-mix(in srgb, var(--success, #22c55e) 10%, transparent)"
                      : isDel ? "color-mix(in srgb, var(--danger) 10%, transparent)" : undefined,
                  }}
                >
                  <span className="w-9 text-right pr-2 text-[var(--text-tertiary)] select-none flex-shrink-0 border-r border-[var(--border-subtle)]">
                    {ln(change, "old")}
                  </span>
                  <span className="w-9 text-right pr-2 text-[var(--text-tertiary)] select-none flex-shrink-0 border-r border-[var(--border-subtle)]">
                    {ln(change, "new")}
                  </span>
                  <span className="w-4 text-center select-none flex-shrink-0"
                    style={{ color: isAdd ? addColor : isDel ? delColor : "var(--text-tertiary)" }}>
                    {sigil}
                  </span>
                  <span className="flex-1 px-2 min-w-0 overflow-x-auto"
                    style={{ color: isAdd ? addColor : isDel ? delColor : "var(--text-primary)" }}>
                    <HL content={content} lang={lang} palette={palette} />
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

// ── Split file view ───────────────────────────────────────────────────────────

interface SplitRow { old: Change | null; new: Change | null; }

function buildSplitRows(changes: Change[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < changes.length) {
    const c = changes[i];
    if (c.type === "normal") {
      rows.push({ old: c, new: c });
      i++;
    } else {
      const dels: Change[] = [];
      const adds: Change[] = [];
      while (i < changes.length && changes[i].type === "del") { dels.push(changes[i++]); }
      while (i < changes.length && changes[i].type === "add") { adds.push(changes[i++]); }
      const max = Math.max(dels.length, adds.length);
      for (let j = 0; j < max; j++) {
        rows.push({ old: dels[j] ?? null, new: adds[j] ?? null });
      }
    }
  }
  return rows;
}

function SplitFile({ file, palette, hunkTop }: { file: File; palette: Palette; hunkTop: number }) {
  const filename = file.to ?? file.from ?? "unknown";
  const lang = langFrom(filename);
  const addBg = "color-mix(in srgb, var(--success, #22c55e) 10%, transparent)";
  const delBg = "color-mix(in srgb, var(--danger) 10%, transparent)";
  return (
    <>
      {file.chunks.map((chunk, ci) => (
        <div key={ci}>
          <div
            className="px-3 py-0.5 text-[0.714rem] text-[var(--text-tertiary)] bg-[var(--surface)] font-mono border-b border-[var(--border-subtle)] sticky z-[9]"
            style={{ top: hunkTop }}
          >
            {chunk.content}
          </div>
          {buildSplitRows(chunk.changes).map((row, ri) => {
            const oldContent = row.old ? row.old.content.slice(1) : "";
            const newContent = row.new ? row.new.content.slice(1) : "";
            const oldBg = row.old?.type === "del" ? delBg : undefined;
            const newBg = row.new?.type === "add" ? addBg : undefined;
            const oldColor = row.old?.type === "del" ? palette["hljs-deletion"] : "var(--text-primary)";
            const newColor = row.new?.type === "add" ? palette["hljs-addition"] : "var(--text-primary)";
            return (
              <div key={ri} className="flex font-mono text-[0.8rem] leading-relaxed">
                <div className="flex flex-1 min-w-0 border-r border-[var(--border-subtle)]" style={{ background: oldBg }}>
                  <span className="w-9 text-right pr-2 text-[var(--text-tertiary)] select-none flex-shrink-0 border-r border-[var(--border-subtle)]">
                    {row.old ? ln(row.old, "old") : ""}
                  </span>
                  <span className="w-4 text-center select-none flex-shrink-0 text-[var(--text-tertiary)]">
                    {row.old?.type === "del" ? "-" : row.old ? " " : ""}
                  </span>
                  <span className="flex-1 px-2 min-w-0 overflow-x-auto" style={{ color: oldColor }}>
                    {row.old && <HL content={oldContent} lang={lang} palette={palette} />}
                  </span>
                </div>
                <div className="flex flex-1 min-w-0" style={{ background: newBg }}>
                  <span className="w-9 text-right pr-2 text-[var(--text-tertiary)] select-none flex-shrink-0 border-r border-[var(--border-subtle)]">
                    {row.new ? ln(row.new, "new") : ""}
                  </span>
                  <span className="w-4 text-center select-none flex-shrink-0 text-[var(--text-tertiary)]">
                    {row.new?.type === "add" ? "+" : row.new ? " " : ""}
                  </span>
                  <span className="flex-1 px-2 min-w-0 overflow-x-auto" style={{ color: newColor }}>
                    {row.new && <HL content={newContent} lang={lang} palette={palette} />}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

// ── FileDiff — file header + collapsible content ──────────────────────────────

export function FileDiff({ file, collapsed, onToggle, mode, palette }: {
  file: File;
  collapsed: boolean;
  onToggle: () => void;
  mode: ViewMode;
  palette: Palette;
}) {
  const filename = file.to ?? file.from ?? "unknown";
  const label = file.from !== file.to && file.from && file.from !== "/dev/null"
    ? `${file.from} → ${filename}`
    : filename;

  const additions = file.chunks.reduce((s, c) => s + c.changes.filter((ch) => ch.type === "add").length, 0);
  const deletions = file.chunks.reduce((s, c) => s + c.changes.filter((ch) => ch.type === "del").length, 0);

  const headerRef = useRef<HTMLButtonElement>(null);
  const [hunkTop, setHunkTop] = useState(32);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHunkTop(el.offsetHeight));
    ro.observe(el);
    setHunkTop(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="border-b border-[var(--border)]">
      <button
        ref={headerRef}
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-[var(--surface)] hover:bg-[var(--surface-2)] transition-colors sticky top-0 z-10 text-left border-b border-[var(--border-subtle)]"
      >
        {collapsed
          ? <ChevronRight size={12} className="flex-shrink-0 text-[var(--text-tertiary)]" />
          : <ChevronDown size={12} className="flex-shrink-0 text-[var(--text-tertiary)]" />}
        <span className="text-[0.786rem] font-mono font-medium text-[var(--text-secondary)] flex-1 truncate">
          {label}
        </span>
        <span className="flex items-center gap-1.5 flex-shrink-0 text-[0.714rem] font-mono">
          {additions > 0 && <span style={{ color: palette["hljs-addition"] }}>+{additions}</span>}
          {deletions > 0 && <span style={{ color: palette["hljs-deletion"] }}>-{deletions}</span>}
        </span>
      </button>

      {!collapsed && (
        mode === "split"
          ? <SplitFile file={file} palette={palette} hunkTop={hunkTop} />
          : <UnifiedFile file={file} palette={palette} changesOnly={mode === "changes"} hunkTop={hunkTop} />
      )}
    </div>
  );
}
