"use client";

/**
 * DiffViewer — working tree diff for the project's codeDirectory.
 *
 * Polls `git diff HEAD` every 5 s. Features:
 *   - Collapsible file sections (chevron toggle)
 *   - Three view modes: unified · split · changes
 *     unified  — standard unified diff, context + adds + deletes
 *     split    — side-by-side old/new columns
 *     changes  — unified but context lines hidden (adds/deletes only)
 */

import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import parseDiff from "parse-diff";
import type { File, Change } from "parse-diff";
import { common, createLowlight } from "lowlight";
import { Copy, Check, RefreshCw, FolderGit2, ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

const lowlight = createLowlight(common);

// ── Palette ───────────────────────────────────────────────────────────────────

type Palette = Record<string, string>;

const PALETTE_DARK: Palette = {
  "hljs-keyword": "#c678dd", "hljs-built_in": "#e5c07b", "hljs-literal": "#56b6c2",
  "hljs-number": "#d19a66", "hljs-string": "#98c379", "hljs-comment": "#5c6370",
  "hljs-variable": "#e06c75", "hljs-attr": "#e06c75", "hljs-title": "#61afef",
  "hljs-type": "#e5c07b", "hljs-operator": "#56b6c2", "hljs-punctuation": "#abb2bf",
  "hljs-tag": "#e06c75", "hljs-meta": "#61afef",
  "hljs-addition": "#98c379", "hljs-deletion": "#e06c75",
};

const PALETTE_LIGHT: Palette = {
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

type ViewMode = "unified" | "split" | "changes";

// ── Line number helper ────────────────────────────────────────────────────────

function ln(change: Change, side: "old" | "new"): number | "" {
  if (!("ln" in change) && !("ln1" in change) && !("ln2" in change)) return "";
  if (change.type === "normal") {
    // parse-diff gives normal changes ln1 (old) and ln2 (new)
    return side === "old"
      ? ("ln1" in change ? (change as { ln1: number }).ln1 : "")
      : ("ln2" in change ? (change as { ln2: number }).ln2 : "");
  }
  if (change.type === "del") return side === "old" ? (change as { ln: number }).ln : "";
  if (change.type === "add") return side === "new" ? (change as { ln: number }).ln : "";
  return "";
}

// ── Unified file view ─────────────────────────────────────────────────────────



function UnifiedFile({ file, palette, changesOnly, hunkTop }: { file: File; palette: Palette; changesOnly: boolean; hunkTop: number }) {
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
                className="px-3 py-0.5 text-[0.714rem] text-[var(--text-tertiary)] bg-[var(--surface)] font-mono border-y border-[var(--border-subtle)] sticky z-[9]"
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
                      ? "color-mix(in srgb, #22c55e 10%, transparent)"
                      : isDel ? "color-mix(in srgb, #ef4444 10%, transparent)" : undefined,
                  }}
                >
                  {/* Old line number */}
                  <span className="w-9 text-right pr-2 text-[var(--text-tertiary)] select-none flex-shrink-0 border-r border-[var(--border-subtle)]">
                    {ln(change, "old")}
                  </span>
                  {/* New line number */}
                  <span className="w-9 text-right pr-2 text-[var(--text-tertiary)] select-none flex-shrink-0 border-r border-[var(--border-subtle)]">
                    {ln(change, "new")}
                  </span>
                  {/* Sigil */}
                  <span className="w-4 text-center select-none flex-shrink-0"
                    style={{ color: isAdd ? addColor : isDel ? delColor : "var(--text-tertiary)" }}>
                    {sigil}
                  </span>
                  {/* Content */}
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
// Pairs del+add lines within each hunk, shows them side by side.

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
      // Collect consecutive del/add block and pair them up
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
  const addBg = "color-mix(in srgb, #22c55e 10%, transparent)";
  const delBg = "color-mix(in srgb, #ef4444 10%, transparent)";
  return (
    <>
      {file.chunks.map((chunk, ci) => (
        <div key={ci}>
          <div
            className="px-3 py-0.5 text-[0.714rem] text-[var(--text-tertiary)] bg-[var(--surface)] font-mono border-y border-[var(--border-subtle)] sticky z-[9]"
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
                {/* Old side */}
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
                {/* New side */}
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

// ── File header + collapse ────────────────────────────────────────────────────

function FileDiff({ file, collapsed, onToggle, mode, palette }: {
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

  // Measure the file header so hunk headers can stick just below it.
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
      {/* File header — sticky within the scroll container */}
      <button
        ref={headerRef}
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-[var(--surface)] hover:bg-[var(--surface-2)] transition-colors sticky top-0 z-10 text-left"
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

      {/* Content */}
      {!collapsed && (
        mode === "split"
          ? <SplitFile file={file} palette={palette} hunkTop={hunkTop} />
          : <UnifiedFile file={file} palette={palette} changesOnly={mode === "changes"} hunkTop={hunkTop} />
      )}
    </div>
  );
}

// ── DiffViewer ────────────────────────────────────────────────────────────────

const POLL_INTERVAL = 5_000;

const MODE_LABELS: { mode: ViewMode; label: string }[] = [
  { mode: "unified", label: "Unified" },
  { mode: "split",   label: "Split" },
  { mode: "changes", label: "Changes" },
];

interface DiffViewerProps {
  cwd: string;
}

export function DiffViewer({ cwd }: DiffViewerProps) {
  const isDark =
    typeof document !== "undefined"
      ? document.documentElement.getAttribute("data-theme") !== "light"
      : true;
  const palette = isDark ? PALETTE_DARK : PALETTE_LIGHT;

  const [diffText, setDiffText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<ViewMode>("unified");
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const isMounted = useRef(true);

  const fetchDiff = useCallback(async () => {
    if (!window.electron) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.electron.agent.gitDiff(cwd) as { data?: string; error?: string } | undefined;
      if (!isMounted.current) return;
      if (result && "error" in result) {
        setError((result as { error: string }).error);
      } else {
        setDiffText((result as { data: string })?.data ?? "");
        setLastRefresh(new Date());
      }
    } catch (e) {
      if (isMounted.current) setError(String(e));
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    isMounted.current = true;
    fetchDiff();
    const id = setInterval(fetchDiff, POLL_INTERVAL);
    return () => { isMounted.current = false; clearInterval(id); };
  }, [fetchDiff]);

  const files = useMemo(() => {
    if (!diffText) return [];
    try { return parseDiff(diffText); } catch { return []; }
  }, [diffText]);

  // Reset collapse state when file list changes (new diff fetch)
  const prevFileCount = useRef(0);
  useEffect(() => {
    if (files.length !== prevFileCount.current) {
      setCollapsed(new Set());
      prevFileCount.current = files.length;
    }
  }, [files.length]);

  const toggleCollapse = useCallback((idx: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setCollapsed(new Set(files.map((_, i) => i)));
  }, [files]);

  const expandAll = useCallback(() => setCollapsed(new Set()), []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(diffText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [diffText]);

  // ── Toolbar ────────────────────────────────────────────────────────────────
  const toolbar = (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0">
      <FolderGit2 size={13} className="text-[var(--text-tertiary)] flex-shrink-0" />
      <span className="text-[0.714rem] text-[var(--text-tertiary)] flex-1 truncate" title={cwd}>
        {files.length > 0
          ? `${files.length} file${files.length !== 1 ? "s" : ""} changed`
          : "Working tree diff"}
      </span>

      {/* View mode toggle */}
      {files.length > 0 && (
        <div className="flex items-center gap-0 border border-[var(--border)] rounded overflow-hidden flex-shrink-0">
          {MODE_LABELS.map(({ mode: m, label }) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "px-2 py-0.5 text-[0.714rem] transition-colors border-r last:border-r-0 border-[var(--border)]",
                mode === m
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Collapse/expand all — single toggle, icon mirrors per-file state */}
      {files.length > 1 && (() => {
        const allCollapsed = files.every((_, i) => collapsed.has(i));
        return (
          <Tooltip content={allCollapsed ? "Expand all" : "Collapse all"} side="bottom">
            <button
              onClick={allCollapsed ? expandAll : collapseAll}
              className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors flex-shrink-0"
            >
              {allCollapsed
                ? <ChevronRight size={13} />
                : <ChevronDown size={13} />}
            </button>
          </Tooltip>
        );
      })()}

      {/* Timestamp */}
      {lastRefresh && (
        <span className="text-[0.714rem] text-[var(--text-tertiary)] flex-shrink-0">
          {lastRefresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
      )}

      {/* Copy */}
      {diffText && (
        <Tooltip content={copied ? "Copied!" : "Copy patch"} side="bottom">
          <button
            onClick={handleCopy}
            className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
          </button>
        </Tooltip>
      )}

      {/* Refresh */}
      <Tooltip content="Refresh" side="bottom">
        <button
          onClick={fetchDiff}
          disabled={loading}
          className={cn(
            "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors",
            loading && "opacity-50 cursor-default"
          )}
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
        </button>
      </Tooltip>
    </div>
  );

  if (error) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {toolbar}
        <div className="flex items-center justify-center flex-1 p-8">
          <p className="text-xs text-[var(--danger)] text-center">{error}</p>
        </div>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {toolbar}
        <div className="flex items-center justify-center flex-1 p-8">
          <p className="text-xs text-[var(--text-tertiary)] text-center">
            {loading ? "Loading…" : "No uncommitted changes"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {toolbar}
      <div className="flex-1 overflow-y-auto">
        {files.map((file, fi) => (
          <FileDiff
            key={fi}
            file={file}
            collapsed={collapsed.has(fi)}
            onToggle={() => toggleCollapse(fi)}
            mode={mode}
            palette={palette}
          />
        ))}
      </div>
    </div>
  );
}
