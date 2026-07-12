"use client";

/**
 * ArchitectureView — a human-facing window into the semantic codebase index
 * that the coding agent builds (codebase_files / codebase_symbols /
 * codebase_relations). Shows headline stats, a symbol-kind breakdown, the
 * indexed files with per-file symbol counts, and — when you drill into a file —
 * its symbols with signatures/docstrings and their call graph (incoming +
 * outgoing references).
 *
 * All data comes from read-only agent:* IPC (see electron/ipc/agent.ts); the
 * index itself is populated by the agent's codebase_reindex tool, and can be
 * (re)built here with the Reindex button.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  RefreshCw,
  Boxes,
  FileCode,
  Layers,
  ChevronRight,
  ChevronDown,
  ArrowRight,
  ArrowLeft,
  Braces,
  Box,
  Hash,
  List,
  Share2,
  Grid3x3,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useCairnStore } from "@/store";
import { CairnEvents } from "@/lib/events";
import { ArchitectureGraphCanvas } from "./ArchitectureGraphCanvas";
import { DependencyMatrix } from "./DependencyMatrix";

interface ArchitectureViewProps {
  cwd: string;
}

interface CodebaseSymbol {
  id: string; file_id: string; name: string; kind: string; line: number;
  signature: string; docstring: string | null; file_path: string; root_path: string;
}
interface CodebaseOverviewFile {
  id: string; file_path: string; root_path: string; indexed_at: string;
  symbol_count: number; relation_count: number;
}
interface CodebaseOverview {
  folder: string; roots: string[]; fileCount: number; totalSymbols: number;
  totalRelations: number; lastIndexedAt: string | null;
  kinds: { kind: string; count: number }[];
  files: CodebaseOverviewFile[];
}
interface CodebaseRelationEdge {
  type: string; target_name: string; source_name: string; source_file: string;
}
interface CodebaseRelations {
  incoming: CodebaseRelationEdge[]; outgoing: CodebaseRelationEdge[];
}
interface CodebaseGraph {
  folder: string;
  nodes: { id: string; file_path: string; root_path: string; symbol_count: number }[];
  edges: { source: string; target: string; weight: number }[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** A stable colour token per symbol kind (theme CSS variables). */
const KIND_COLOR: Record<string, string> = {
  class: "var(--accent)",
  interface: "var(--success)",
  struct: "var(--warning)",
  function: "var(--info, var(--accent))",
  method: "var(--text-secondary)",
  module: "var(--danger)",
};
function kindColor(kind: string): string {
  return KIND_COLOR[kind] ?? "var(--text-tertiary)";
}

const KIND_ICON: Record<string, typeof Box> = {
  class: Box,
  interface: Braces,
  struct: Box,
  function: Hash,
  method: Hash,
  module: Layers,
};
function KindGlyph({ kind, size = 12 }: { kind: string; size?: number }) {
  const Icon = KIND_ICON[kind] ?? Hash;
  return <Icon size={size} style={{ color: kindColor(kind) }} className="flex-shrink-0" />;
}

/** file_path relative to the indexed root, for compact display. */
function relPath(filePath: string, root: string): string {
  if (root && filePath.startsWith(root)) {
    const r = filePath.slice(root.length).replace(/^[/\\]/, "");
    return r || filePath;
  }
  return filePath;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// ── Component ─────────────────────────────────────────────────────────────

export function ArchitectureView({ cwd }: ArchitectureViewProps) {
  const [overview, setOverview] = useState<CodebaseOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Files with no extracted symbols (e.g. plain .md docs, config) are hidden by
  // default — they'd otherwise clutter the list with "0" rows. Toggleable.
  const [showEmpty, setShowEmpty] = useState(false);
  // List (file tree) vs. Matrix (DSM) vs. Graph (spotlight force graph).
  const [view, setView] = useState<"list" | "matrix" | "graph">("matrix");
  const [graph, setGraph] = useState<CodebaseGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);

  // Per-file expansion → lazily loaded symbols.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [fileSymbols, setFileSymbols] = useState<Record<string, CodebaseSymbol[]>>({});

  // Selected symbol → its call graph.
  const [selected, setSelected] = useState<CodebaseSymbol | null>(null);
  const [relations, setRelations] = useState<CodebaseRelations | null>(null);
  // Selected file node in graph view.
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    try {
      const data = await window.electron?.agent.codebaseOverview(cwd);
      if (data) setOverview(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    setOverview(null);
    setExpanded(new Set());
    setFileSymbols({});
    setSelected(null);
    setRelations(null);
    setGraph(null);
    setSelectedFileId(null);
    void load();
  }, [load]);

  const reindex = useCallback(async () => {
    if (!cwd || reindexing) return;
    setReindexing(true);
    setError(null);
    try {
      const data = await window.electron?.agent.codebaseReindex(cwd);
      if (data) {
        setOverview(data);
        setExpanded(new Set());
        setFileSymbols({});
        setSelected(null);
        setRelations(null);
        setGraph(null); // force graph refetch next time graph view opens
        setSelectedFileId(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReindexing(false);
    }
  }, [cwd, reindexing]);

  const toggleFile = useCallback(async (file: CodebaseOverviewFile) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(file.id)) next.delete(file.id);
      else next.add(file.id);
      return next;
    });
    if (!fileSymbols[file.id]) {
      try {
        const data = await window.electron?.agent.codebaseFileSymbols(file.file_path);
        if (data) setFileSymbols((prev) => ({ ...prev, [file.id]: data }));
      } catch {
        /* leave the file empty on error */
      }
    }
  }, [fileSymbols]);

  const selectSymbol = useCallback(async (sym: CodebaseSymbol) => {
    setSelected(sym);
    setRelations(null);
    // Open the file in the editor and jump to the symbol's line.
    useCairnStore.getState().openEditorFile(sym.file_path);
    window.dispatchEvent(CairnEvents.openFileAtLine(sym.file_path, sym.line));
    try {
      const data = await window.electron?.agent.codebaseRelations(sym.name, cwd);
      if (data) setRelations(data);
    } catch {
      /* no relations on error */
    }
  }, [cwd]);

  // Lazily load the file-dependency graph the first time a graph-based view
  // (matrix or spotlight) opens, and after a reindex clears it.
  useEffect(() => {
    if ((view !== "graph" && view !== "matrix") || !cwd || graph) return;
    let cancelled = false;
    setGraphLoading(true);
    window.electron?.agent
      .codebaseGraph(cwd)
      .then((data) => { if (!cancelled && data) setGraph(data); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setGraphLoading(false); });
    return () => { cancelled = true; };
  }, [view, cwd, graph]);

  // Load a file's symbols into the shared cache (used by the graph side panel).
  const openFileInPanel = useCallback(async (fileId: string, filePath: string) => {
    if (fileSymbols[fileId]) return;
    try {
      const data = await window.electron?.agent.codebaseFileSymbols(filePath);
      if (data) setFileSymbols((prev) => ({ ...prev, [fileId]: data }));
    } catch {
      /* leave empty on error */
    }
  }, [fileSymbols]);

  const root = overview?.roots[0] ?? overview?.folder ?? cwd;
  const maxKind = useMemo(
    () => Math.max(1, ...(overview?.kinds.map((k) => k.count) ?? [1])),
    [overview],
  );

  const filteredFiles = useMemo(() => {
    if (!overview) return [];
    const q = query.trim().toLowerCase();
    return overview.files.filter((f) => {
      if (!showEmpty && f.symbol_count === 0) return false;
      if (q && !relPath(f.file_path, root).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [overview, query, root, showEmpty]);

  const emptyFileCount = useMemo(
    () => overview?.files.filter((f) => f.symbol_count === 0).length ?? 0,
    [overview],
  );

  // ── Empty / loading states ──
  if (!cwd) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-tertiary)]">
        Set a code directory in project settings to see its architecture.
      </div>
    );
  }

  const isEmpty = overview != null && overview.fileCount === 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Header / stats bar */}
      <div className="flex items-center gap-3 px-4 h-11 border-b border-[var(--border)] bg-[var(--surface-2)] flex-shrink-0">
        <Boxes size={15} className="text-[var(--accent)] flex-shrink-0" />
        <div className="flex items-center gap-4 text-xs text-[var(--text-secondary)] min-w-0">
          <Stat label="files" value={overview?.fileCount ?? "—"} />
          <Stat label="symbols" value={overview?.totalSymbols ?? "—"} />
          <Stat label="references" value={overview?.totalRelations ?? "—"} />
          <span className="text-[var(--text-tertiary)] truncate hidden lg:inline">
            indexed {formatWhen(overview?.lastIndexedAt ?? null)}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          {/* Matrix / Graph / List view toggle */}
          <div className="flex items-center rounded-md border border-[var(--border)] overflow-hidden">
            <button
              onClick={() => setView("matrix")}
              className={cn(
                "flex items-center gap-1 px-2 py-1 text-[0.7rem] font-semibold transition-colors",
                view === "matrix"
                  ? "bg-[var(--surface-3)] text-[var(--text-primary)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
              )}
              title="Dependency matrix"
            >
              <Grid3x3 size={12} /> Matrix
            </button>
            <button
              onClick={() => setView("graph")}
              className={cn(
                "flex items-center gap-1 px-2 py-1 text-[0.7rem] font-semibold transition-colors border-l border-[var(--border)]",
                view === "graph"
                  ? "bg-[var(--surface-3)] text-[var(--text-primary)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
              )}
              title="Dependency graph"
            >
              <Share2 size={12} /> Graph
            </button>
            <button
              onClick={() => setView("list")}
              className={cn(
                "flex items-center gap-1 px-2 py-1 text-[0.7rem] font-semibold transition-colors border-l border-[var(--border)]",
                view === "list"
                  ? "bg-[var(--surface-3)] text-[var(--text-primary)]"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
              )}
              title="File list"
            >
              <List size={12} /> List
            </button>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={reindex}
            disabled={reindexing || loading}
            className="gap-1.5"
            title="Rebuild the codebase index"
          >
            <RefreshCw size={13} className={cn(reindexing && "animate-spin")} />
            {reindexing ? "Indexing…" : "Reindex"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-[var(--danger)] border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] flex-shrink-0">
          {error}
        </div>
      )}

      {loading && !overview ? (
        <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-tertiary)] gap-2">
          <RefreshCw size={14} className="animate-spin" /> Loading index…
        </div>
      ) : isEmpty ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
          <FileCode size={28} className="text-[var(--text-tertiary)]" />
          <div className="text-sm text-[var(--text-secondary)] max-w-sm">
            This codebase hasn&apos;t been indexed yet. Build the index to explore
            its classes, functions and their call graph here.
          </div>
          <Button size="sm" onClick={reindex} disabled={reindexing} className="gap-1.5">
            <RefreshCw size={13} className={cn(reindexing && "animate-spin")} />
            {reindexing ? "Indexing…" : "Build index"}
          </Button>
        </div>
      ) : overview && view === "matrix" ? (
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {graphLoading && !graph ? (
            <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-tertiary)] gap-2">
              <RefreshCw size={14} className="animate-spin" /> Building matrix…
            </div>
          ) : (
            <DependencyMatrix
              nodes={graph?.nodes ?? []}
              edges={graph?.edges ?? []}
              root={root}
              selectedId={selectedFileId}
              onSelect={(id) => {
                setSelectedFileId(id);
                const f = graph?.nodes.find((n) => n.id === id);
                if (f) void openFileInPanel(f.id, f.file_path);
              }}
            />
          )}
          {/* Selected-file symbol panel (shared with graph view) */}
          <div className="w-72 flex-shrink-0 border-l border-[var(--border)] overflow-y-auto hidden lg:block">
            {selectedFileId ? (
              <SelectedFilePanel
                filePath={graph?.nodes.find((n) => n.id === selectedFileId)?.file_path ?? ""}
                root={root}
                symbols={fileSymbols[selectedFileId] ?? []}
                onFocusInGraph={() => setView("graph")}
              />
            ) : (
              <div className="p-4 text-center text-xs text-[var(--text-tertiary)]">
                Rows and columns are files (ordered by path). A cell means the row&apos;s file references the column&apos;s file — darker = more references. Red marks a dependency cycle. Click a row to inspect a file.
              </div>
            )}
          </div>
        </div>
      ) : overview && view === "graph" ? (
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {graphLoading && !graph ? (
            <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-tertiary)] gap-2">
              <RefreshCw size={14} className="animate-spin" /> Building graph…
            </div>
          ) : (
            <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
              {/* Spotlight banner when focused on one file */}
              {selectedFileId && (
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--surface-2)] flex-shrink-0 text-[0.7rem]">
                  <Share2 size={12} className="text-[var(--accent)]" />
                  <span className="text-[var(--text-secondary)]">
                    Focused on <span className="font-mono">{relPath(graph?.nodes.find((n) => n.id === selectedFileId)?.file_path ?? "", root)}</span> and its direct dependencies
                  </span>
                  <button
                    onClick={() => setSelectedFileId(null)}
                    className="ml-auto text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    Show all
                  </button>
                </div>
              )}
              <ArchitectureGraphCanvas
                nodes={graph?.nodes ?? []}
                edges={graph?.edges ?? []}
                root={root}
                focusId={selectedFileId}
                selectedId={selectedFileId}
                onSelect={(n) => {
                  setSelectedFileId(n?.id ?? null);
                  if (n) void openFileInPanel(n.id, n.file_path);
                }}
              />
            </div>
          )}
          {/* Selected-file symbol panel */}
          <div className="w-72 flex-shrink-0 border-l border-[var(--border)] overflow-y-auto hidden lg:block">
            {selectedFileId ? (
              <SelectedFilePanel
                filePath={graph?.nodes.find((n) => n.id === selectedFileId)?.file_path ?? ""}
                root={root}
                symbols={fileSymbols[selectedFileId] ?? []}
              />
            ) : (
              <div className="p-4 text-center text-xs text-[var(--text-tertiary)]">
                Click a file node to spotlight it — the graph will focus on that file and its direct dependencies. Node size = number of symbols; arrows point from a file to the files it references.
              </div>
            )}
          </div>
        </div>
      ) : overview ? (
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Left column — kinds + file list */}
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden border-r border-[var(--border)]">
            {/* Symbol-kind breakdown */}
            {overview.kinds.length > 0 && (
              <div className="px-4 py-3 border-b border-[var(--border)] flex-shrink-0">
                <div className="text-[0.7rem] uppercase tracking-wide text-[var(--text-tertiary)] mb-2">
                  Symbols by kind
                </div>
                <div className="flex flex-col gap-1.5">
                  {overview.kinds.map((k) => (
                    <div key={k.kind} className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5 w-24 flex-shrink-0">
                        <KindGlyph kind={k.kind} />
                        <span className="text-xs text-[var(--text-secondary)] capitalize truncate">{k.kind}</span>
                      </div>
                      <div className="flex-1 h-2 rounded-full bg-[var(--surface-3)] overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${(k.count / maxKind) * 100}%`,
                            background: kindColor(k.kind),
                          }}
                        />
                      </div>
                      <span className="text-xs text-[var(--text-tertiary)] w-10 text-right tabular-nums flex-shrink-0">
                        {k.count}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* File filter */}
            <div className="px-4 py-2 border-b border-[var(--border)] flex-shrink-0 flex flex-col gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter files…"
                className="w-full px-2.5 py-1.5 text-xs rounded-md bg-[var(--surface)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] transition-colors"
              />
              {emptyFileCount > 0 && (
                <button
                  onClick={() => setShowEmpty((v) => !v)}
                  className="self-start text-[0.7rem] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
                >
                  {showEmpty
                    ? `Hide ${emptyFileCount} file${emptyFileCount === 1 ? "" : "s"} with no symbols`
                    : `Show ${emptyFileCount} file${emptyFileCount === 1 ? "" : "s"} with no symbols`}
                </button>
              )}
            </div>

            {/* File list */}
            <div className="flex-1 overflow-y-auto">
              {filteredFiles.map((file) => {
                const isOpen = expanded.has(file.id);
                const syms = fileSymbols[file.id] ?? [];
                return (
                  <div key={file.id} className="border-b border-[var(--border-subtle,var(--border))]">
                    <button
                      onClick={() => toggleFile(file)}
                      className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-[var(--surface-2)] transition-colors"
                    >
                      {isOpen ? (
                        <ChevronDown size={13} className="text-[var(--text-tertiary)] flex-shrink-0" />
                      ) : (
                        <ChevronRight size={13} className="text-[var(--text-tertiary)] flex-shrink-0" />
                      )}
                      <FileCode size={13} className="text-[var(--text-tertiary)] flex-shrink-0" />
                      <span className="text-xs text-[var(--text-primary)] font-mono truncate flex-1">
                        {relPath(file.file_path, root)}
                      </span>
                      <span className="text-[0.7rem] text-[var(--text-tertiary)] tabular-nums flex-shrink-0">
                        {file.symbol_count}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="pb-1">
                        {syms.length === 0 ? (
                          <div className="pl-11 pr-4 py-1 text-[0.7rem] text-[var(--text-tertiary)]">
                            No symbols extracted.
                          </div>
                        ) : (
                          syms.map((sym) => (
                            <button
                              key={sym.id}
                              onClick={() => selectSymbol(sym)}
                              className={cn(
                                "w-full flex items-center gap-2 pl-11 pr-4 py-1 text-left hover:bg-[var(--surface-2)] transition-colors",
                                selected?.id === sym.id && "bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]",
                              )}
                            >
                              <KindGlyph kind={sym.kind} />
                              <span className="text-xs text-[var(--text-secondary)] font-mono truncate flex-1">
                                {sym.name}
                              </span>
                              <span className="text-[0.7rem] text-[var(--text-tertiary)] tabular-nums flex-shrink-0">
                                :{sym.line}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {filteredFiles.length === 0 && (
                <div className="px-4 py-6 text-center text-xs text-[var(--text-tertiary)]">
                  No files match &ldquo;{query}&rdquo;.
                </div>
              )}
            </div>
          </div>

          {/* Right column — selected symbol + call graph */}
          <div className="w-80 flex-shrink-0 flex flex-col overflow-hidden hidden xl:flex">
            {selected ? (
              <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4 min-h-0">
                <div className="flex-shrink-0">
                  <div className="flex items-center gap-2 mb-1">
                    <KindGlyph kind={selected.kind} size={14} />
                    <span className="text-sm font-semibold text-[var(--text-primary)] font-mono break-all">
                      {selected.name}
                    </span>
                  </div>
                  <div className="text-[0.7rem] text-[var(--text-tertiary)] font-mono break-all">
                    {relPath(selected.file_path, root)}:{selected.line}
                  </div>
                </div>

                {selected.signature && (
                  <pre className="flex-shrink-0 text-[0.7rem] leading-relaxed font-mono text-[var(--text-secondary)] bg-[var(--surface-2)] border border-[var(--border)] rounded-md p-2.5 overflow-x-auto whitespace-pre-wrap break-words m-0">
                    {selected.signature}
                  </pre>
                )}

                {selected.docstring && (
                  <div className="flex-shrink-0 text-xs text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap break-words">
                    {selected.docstring}
                  </div>
                )}

                {/* Call graph */}
                <RelationList
                  title="Calls / uses"
                  icon={<ArrowRight size={12} className="text-[var(--text-tertiary)]" />}
                  edges={relations?.outgoing ?? []}
                  field="target_name"
                  empty="No outgoing references."
                />
                <RelationList
                  title="Referenced by"
                  icon={<ArrowLeft size={12} className="text-[var(--text-tertiary)]" />}
                  edges={relations?.incoming ?? []}
                  field="source_name"
                  empty="No incoming references."
                  showFile
                  root={root}
                />
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-center text-xs text-[var(--text-tertiary)] px-6">
                Select a symbol to see its signature, docstring and call graph.
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

/** Shared side panel: the selected file's path + its symbols (matrix + graph). */
function SelectedFilePanel({
  filePath, root, symbols, onFocusInGraph,
}: {
  filePath: string;
  root: string;
  symbols: CodebaseSymbol[];
  onFocusInGraph?: () => void;
}) {
  const rel = (p: string) => (root && p.startsWith(root) ? p.slice(root.length).replace(/^[/\\]/, "") || p : p);
  return (
    <div className="p-3">
      <div className="text-xs font-mono text-[var(--text-primary)] break-all mb-2">{rel(filePath)}</div>
      {onFocusInGraph && (
        <button
          onClick={onFocusInGraph}
          className="mb-2 text-[0.7rem] text-[var(--accent)] hover:underline"
        >
          Focus in graph →
        </button>
      )}
      {symbols.length === 0 ? (
        <div className="text-[0.7rem] text-[var(--text-tertiary)]">No symbols in this file.</div>
      ) : (
        <div className="flex flex-col">
          {symbols.map((sym) => (
            <div key={sym.id} className="flex items-center gap-2 py-1">
              <KindGlyph kind={sym.kind} />
              <span className="text-xs text-[var(--text-secondary)] font-mono truncate flex-1">{sym.name}</span>
              <span className="text-[0.65rem] text-[var(--text-tertiary)] tabular-nums">:{sym.line}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {  return (
    <span className="flex items-baseline gap-1 flex-shrink-0">
      <span className="text-sm font-semibold text-[var(--text-primary)] tabular-nums">{value}</span>
      <span className="text-[var(--text-tertiary)]">{label}</span>
    </span>
  );
}

function RelationList({
  title, icon, edges, field, empty, showFile = false, root = "",
}: {
  title: string;
  icon: React.ReactNode;
  edges: CodebaseRelationEdge[];
  field: "target_name" | "source_name";
  empty: string;
  showFile?: boolean;
  root?: string;
}) {
  // De-dupe by the displayed name to keep the list tidy.
  const items = useMemo(() => {
    const seen = new Map<string, CodebaseRelationEdge>();
    for (const e of edges) {
      const key = e[field];
      if (!seen.has(key)) seen.set(key, e);
    }
    return Array.from(seen.values());
  }, [edges, field]);

  return (
    <div>
      <div className="flex items-center gap-1.5 text-[0.7rem] uppercase tracking-wide text-[var(--text-tertiary)] mb-1.5">
        {icon}
        {title}
        <span className="tabular-nums">({items.length})</span>
      </div>
      {items.length === 0 ? (
        <div className="text-[0.7rem] text-[var(--text-tertiary)]">{empty}</div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {items.map((e, i) => (
            <div key={`${e[field]}-${i}`} className="flex items-center gap-2 text-xs">
              <span className="font-mono text-[var(--text-secondary)] truncate">{e[field]}</span>
              {showFile && e.source_file && (
                <span className="text-[0.65rem] text-[var(--text-tertiary)] font-mono truncate ml-auto">
                  {relPath(e.source_file, root)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
