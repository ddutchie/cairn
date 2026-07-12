"use client";

/**
 * ArchitectureSidebar — a contextual, editor-scoped view of the codebase index.
 * Reads the currently active editor file from the store and shows the symbols
 * defined in it; expand a symbol to see its call graph (what it calls, and what
 * references it). It's the focused counterpart to the whole-repo Architecture
 * tab — "what's the structure of the file I'm looking at?".
 *
 * Data comes from the same read-only agent:codebase* IPC. Collapsible so it
 * doesn't steal editor width when not needed.
 */

import { useState, useEffect, useCallback } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import {
  Boxes,
  ChevronRight,
  ChevronDown,
  ChevronLeft,
  ArrowRight,
  ArrowLeft,
  Braces,
  Box,
  Hash,
  Layers,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface CodebaseSymbol {
  id: string; file_id: string; name: string; kind: string; line: number;
  signature: string; docstring: string | null; file_path: string; root_path: string;
}
interface CodebaseRelationEdge {
  type: string; target_name: string; source_name: string; source_file: string;
}
interface CodebaseRelations {
  incoming: CodebaseRelationEdge[]; outgoing: CodebaseRelationEdge[];
}

const KIND_COLOR: Record<string, string> = {
  class: "var(--accent)",
  interface: "var(--success)",
  struct: "var(--warning)",
  function: "var(--info, var(--accent))",
  method: "var(--text-secondary)",
  module: "var(--danger)",
};
const KIND_ICON: Record<string, typeof Box> = {
  class: Box, interface: Braces, struct: Box, function: Hash, method: Hash, module: Layers,
};
function KindGlyph({ kind, size = 12 }: { kind: string; size?: number }) {
  const Icon = KIND_ICON[kind] ?? Hash;
  return <Icon size={size} style={{ color: KIND_COLOR[kind] ?? "var(--text-tertiary)" }} className="flex-shrink-0" />;
}

function baseName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? filePath;
}

export function ArchitectureSidebar() {
  const { activeEditorFile, openEditorFiles } = useCairnStore(
    useShallow((s) => ({ activeEditorFile: s.activeEditorFile, openEditorFiles: s.openEditorFiles })),
  );
  const filePath = activeEditorFile ?? openEditorFiles[0] ?? null;

  const [collapsed, setCollapsed] = useState(false);
  const [symbols, setSymbols] = useState<CodebaseSymbol[]>([]);
  const [loading, setLoading] = useState(false);
  const [notIndexed, setNotIndexed] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [relations, setRelations] = useState<Record<string, CodebaseRelations>>({});

  useEffect(() => {
    setExpanded(null);
    setRelations({});
    if (!filePath) { setSymbols([]); setNotIndexed(false); return; }
    let cancelled = false;
    setLoading(true);
    setNotIndexed(false);
    window.electron?.agent
      .codebaseFileSymbols(filePath)
      .then((data) => {
        if (cancelled) return;
        setSymbols(data ?? []);
        setNotIndexed((data ?? []).length === 0);
      })
      .catch(() => { if (!cancelled) { setSymbols([]); setNotIndexed(true); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filePath]);

  const toggleSymbol = useCallback(async (sym: CodebaseSymbol) => {
    const next = expanded === sym.id ? null : sym.id;
    setExpanded(next);
    if (next && !relations[sym.id]) {
      try {
        const data = await window.electron?.agent.codebaseRelations(sym.name);
        if (data) setRelations((prev) => ({ ...prev, [sym.id]: data }));
      } catch {
        /* ignore */
      }
    }
  }, [expanded, relations]);

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="w-8 flex-shrink-0 border-l border-[var(--border)] bg-[var(--surface-2)] flex flex-col items-center pt-2 gap-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
        title="Show architecture panel"
      >
        <ChevronLeft size={14} />
        <Boxes size={14} />
      </button>
    );
  }

  return (
    <div className="w-64 flex-shrink-0 flex flex-col border-l border-[var(--border)] bg-[var(--surface-2)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-[var(--border)] flex-shrink-0">
        <Boxes size={13} className="text-[var(--accent)]" />
        <span className="text-[0.7rem] uppercase tracking-wide text-[var(--text-tertiary)] flex-1 truncate">
          Architecture
        </span>
        <button
          onClick={() => setCollapsed(true)}
          className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
          title="Hide panel"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      {/* File name */}
      {filePath && (
        <div className="px-3 py-2 border-b border-[var(--border)] flex-shrink-0">
          <div className="text-xs font-mono text-[var(--text-secondary)] truncate" title={filePath}>
            {baseName(filePath)}
          </div>
          <div className="text-[0.65rem] text-[var(--text-tertiary)]">
            {symbols.length} symbol{symbols.length === 1 ? "" : "s"}
          </div>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {!filePath ? (
          <div className="p-4 text-center text-[0.7rem] text-[var(--text-tertiary)]">
            Open a file to see its structure.
          </div>
        ) : loading ? (
          <div className="p-4 text-center text-[0.7rem] text-[var(--text-tertiary)]">Loading…</div>
        ) : notIndexed ? (
          <div className="p-4 text-center text-[0.7rem] text-[var(--text-tertiary)]">
            No indexed symbols for this file. Reindex from the Architecture tab.
          </div>
        ) : (
          symbols.map((sym) => {
            const isOpen = expanded === sym.id;
            const rel = relations[sym.id];
            return (
              <div key={sym.id} className="border-b border-[var(--border-subtle,var(--border))]">
                <button
                  onClick={() => toggleSymbol(sym)}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-[var(--surface-3)] transition-colors"
                >
                  {isOpen ? (
                    <ChevronDown size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
                  ) : (
                    <ChevronRight size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
                  )}
                  <KindGlyph kind={sym.kind} />
                  <span className="text-xs text-[var(--text-secondary)] font-mono truncate flex-1">{sym.name}</span>
                  <span className="text-[0.65rem] text-[var(--text-tertiary)] tabular-nums">:{sym.line}</span>
                </button>
                {isOpen && (
                  <div className="px-3 pb-2 pl-7 flex flex-col gap-2">
                    {sym.signature && (
                      <pre className="text-[0.65rem] font-mono text-[var(--text-tertiary)] whitespace-pre-wrap break-words m-0">
                        {sym.signature}
                      </pre>
                    )}
                    <RelBlock
                      icon={<ArrowRight size={10} className="text-[var(--text-tertiary)]" />}
                      label="Calls"
                      edges={rel?.outgoing ?? []}
                      field="target_name"
                    />
                    <RelBlock
                      icon={<ArrowLeft size={10} className="text-[var(--text-tertiary)]" />}
                      label="Called by"
                      edges={rel?.incoming ?? []}
                      field="source_name"
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function RelBlock({
  icon, label, edges, field,
}: {
  icon: React.ReactNode;
  label: string;
  edges: CodebaseRelationEdge[];
  field: "target_name" | "source_name";
}) {
  const names = Array.from(new Set(edges.map((e) => e[field])));
  if (names.length === 0) {
    return (
      <div className="text-[0.65rem] text-[var(--text-tertiary)] flex items-center gap-1">
        {icon} {label}: <span className="opacity-70">none</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1 text-[0.65rem] uppercase tracking-wide text-[var(--text-tertiary)]">
        {icon} {label} ({names.length})
      </div>
      {names.map((n) => (
        <div key={n} className="text-[0.7rem] font-mono text-[var(--text-secondary)] truncate pl-3">
          {n}
        </div>
      ))}
    </div>
  );
}
