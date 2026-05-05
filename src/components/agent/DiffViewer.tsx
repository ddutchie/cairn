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
import { Copy, Check, RefreshCw, FolderGit2, ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { FileDiff, PALETTE_DARK, PALETTE_LIGHT } from "./DiffFile";
import type { ViewMode } from "./DiffFile";

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL = 5_000;

const MODE_LABELS: { mode: ViewMode; label: string }[] = [
  { mode: "unified", label: "Unified" },
  { mode: "split",   label: "Split" },
  { mode: "changes", label: "Changes" },
];

// ── DiffViewer ────────────────────────────────────────────────────────────────

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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const isMounted = useRef(true);

  const fetchDiff = useCallback(async () => {
    if (!window.electron) return;
    setLoading(true);
    setError(null);
    try {
      const diff = await window.electron.agent.gitDiff(cwd);
      if (!isMounted.current) return;
      setDiffText(diff ?? "");
      setLastRefresh(new Date());
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

  const toggleCollapse = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); } else { next.add(key); }
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setCollapsed(new Set(files.map((f) => f.to ?? f.from ?? "")));
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
        const allCollapsed = files.every((f) => collapsed.has(f.to ?? f.from ?? ""));
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
        {files.map((file, fi) => {
          const fileKey = file.to ?? file.from ?? String(fi);
          return (
            <FileDiff
              key={fileKey}
              file={file}
              collapsed={collapsed.has(fileKey)}
              onToggle={() => toggleCollapse(fileKey)}
              mode={mode}
              palette={palette}
            />
          );
        })}
      </div>
    </div>
  );
}
