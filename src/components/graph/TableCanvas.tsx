"use client";

import React, { useMemo, useState, useCallback } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { GraphNode, GraphNodeType } from "@/types";
import { NodeTypeChip } from "./NodeTypeChip";
import { PRIORITY_COLOR, PRIORITY_SORT_ORDER } from "./analyticsUtils";

interface Props {
  nodes: GraphNode[];
  onNodeClick: (node: GraphNode) => void;
  selectedNodeId: string | null;
  // Search/filter state lifted to toolbar (KnowledgeGraphView manages these)
  search: string;
  typeFilter: GraphNodeType[];
}

type SortKey = "title" | "type" | "project" | "priority" | "updatedAt";
type SortDir = "asc" | "desc";

const TYPE_ORDER: GraphNodeType[] = ["project", "note", "card", "tag"];

export function TableCanvas({ nodes, onNodeClick, selectedNodeId, search, typeFilter }: Props) {
  const { projects, notes, cards, tags } = useCairnStore(useShallow((s) => ({ projects: s.projects, notes: s.notes, cards: s.cards, tags: s.tags })));
  const [sortKey, setSortKey] = useState<SortKey>("type");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const projectName = useCallback(
    (id: string | undefined) => id ? (projects.find((p) => p.id === id)?.name ?? "—") : "—",
    [projects]
  );

  const rows = useMemo(() =>
    nodes.map((n) => {
      let priority = "";
      let updatedAt = "";
      let snippet = n.meta?.snippet ?? "";
      let tagColor = "";

      if (n.type === "note") {
        const note = notes.find((x) => x.id === n.id);
        updatedAt = note?.updatedAt ?? "";
        snippet = note?.contentText?.slice(0, 80) ?? "";
      } else if (n.type === "card") {
        const card = cards.find((x) => x.id === n.id);
        priority = card?.priority ?? "medium";
        updatedAt = card?.updatedAt ?? "";
        snippet = card?.description?.slice(0, 80) ?? "";
      } else if (n.type === "project") {
        const proj = projects.find((x) => x.id === n.id);
        priority = proj?.priority ?? "medium";
        updatedAt = proj?.updatedAt ?? "";
      } else if (n.type === "tag") {
        const tag = tags.find((x) => x.id === n.id);
        updatedAt = "";
        snippet = ""; // don't show hex string
        tagColor = tag?.color ?? "";
      }

      return { node: n, priority, updatedAt, snippet, tagColor };
    }),
    [nodes, notes, cards, projects, tags]
  );

  const filtered = useMemo(() => {
    let r = rows;
    if (typeFilter.length > 0) r = r.filter((x) => typeFilter.includes(x.node.type));
    if (search.trim()) {
      const q = search.toLowerCase();
      r = r.filter(
        (x) =>
          x.node.title.toLowerCase().includes(q) ||
          x.snippet.toLowerCase().includes(q) ||
          projectName(x.node.projectId).toLowerCase().includes(q)
      );
    }
    return r;
  }, [rows, typeFilter, search, projectName]);

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "title":    return dir * a.node.title.localeCompare(b.node.title);
        case "type":     return dir * (TYPE_ORDER.indexOf(a.node.type) - TYPE_ORDER.indexOf(b.node.type));
        case "project":  return dir * projectName(a.node.projectId).localeCompare(projectName(b.node.projectId));
        case "priority": return dir * ((PRIORITY_SORT_ORDER[a.priority] ?? 4) - (PRIORITY_SORT_ORDER[b.priority] ?? 4));
        case "updatedAt": return dir * a.updatedAt.localeCompare(b.updatedAt);
        default:         return 0;
      }
    });
  }, [filtered, sortKey, sortDir, projectName]);

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  }

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ArrowUpDown size={10} className="text-[var(--text-tertiary)] opacity-50" />;
    return sortDir === "asc"
      ? <ArrowUp size={10} className="text-[var(--accent)]" />
      : <ArrowDown size={10} className="text-[var(--accent)]" />;
  }

  // Only show priority column when some rows can have priority (cards or projects visible)
  const showPriority = typeFilter.length === 0
    ? sorted.some((r) => r.priority !== "")
    : typeFilter.some((t) => t === "card" || t === "project");

  return (
    <div className="flex-1 overflow-auto min-h-0">
      <table className="w-full text-xs border-collapse">
        <thead className="sticky top-0 bg-[var(--surface)] z-10">
          <tr className="border-b border-[var(--border)]">
            {(
              [
                { key: "type"      as SortKey, label: "Type",    w: "w-20"   },
                { key: "title"     as SortKey, label: "Title",   w: "min-w-48" },
                { key: "project"   as SortKey, label: "Project", w: "w-36"   },
                ...(showPriority ? [{ key: "priority" as SortKey, label: "Priority", w: "w-24" }] : []),
                { key: "updatedAt" as SortKey, label: "Updated", w: "w-32"   },
              ] as { key: SortKey; label: string; w: string }[]
            ).map(({ key, label, w }) => (
              <th
                key={key}
                className={cn(
                  "px-3 py-2 text-left font-medium text-[var(--text-tertiary)] cursor-pointer select-none hover:text-[var(--text-secondary)] transition-colors",
                  w
                )}
                onClick={() => handleSort(key)}
              >
                <div className="flex items-center gap-1">
                  {label}
                  <SortIcon col={key} />
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(({ node, priority, updatedAt, snippet, tagColor }, i) => {
            const isSelected = node.id === selectedNodeId;
            const updated = updatedAt
              ? new Date(updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" })
              : "—";

            return (
              <tr
                key={node.id}
                onClick={() => onNodeClick(node)}
                className={cn(
                  "border-b border-[var(--border-subtle)] cursor-pointer transition-colors",
                  isSelected
                    ? "bg-[var(--accent-dim)]"
                    : i % 2 === 1
                    ? "bg-[var(--surface-2)]/30 hover:bg-[var(--surface-2)]"
                    : "hover:bg-[var(--surface-2)]"
                )}
              >
                {/* Type */}
                <td className="px-3 py-2">
                  <NodeTypeChip type={node.type} />
                </td>

                {/* Title + snippet */}
                <td className="px-3 py-2 max-w-0">
                  <p className="text-[var(--text-primary)] truncate font-medium">{node.title}</p>
                  {node.type === "tag" && tagColor ? (
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ background: tagColor }}
                      />
                      <span className="text-[0.786rem] text-[var(--text-tertiary)] font-mono">{tagColor}</span>
                    </div>
                  ) : snippet ? (
                    <p className="text-[0.786rem] text-[var(--text-tertiary)] truncate mt-0.5">{snippet}</p>
                  ) : null}
                </td>

                {/* Project */}
                <td className="px-3 py-2 text-[var(--text-secondary)] truncate max-w-0">
                  {projectName(node.projectId)}
                </td>

                {/* Priority — only when column shown */}
                {showPriority && (
                  <td className="px-3 py-2">
                    {priority ? (
                      <span
                        className="inline-flex items-center gap-1 text-[0.714rem] capitalize"
                        style={{
                          color: PRIORITY_COLOR[priority ?? "medium"] ?? PRIORITY_COLOR.medium,
                        }}
                      >
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: "currentColor" }} />
                        {priority}
                      </span>
                    ) : (
                      <span className="text-[var(--text-tertiary)] opacity-30">—</span>
                    )}
                  </td>
                )}

                {/* Updated */}
                <td className="px-3 py-2 text-[var(--text-tertiary)] font-mono text-[0.786rem]">{updated}</td>
              </tr>
            );
          })}

          {sorted.length === 0 && (
            <tr>
              <td colSpan={showPriority ? 5 : 4} className="px-3 py-10 text-center text-[var(--text-tertiary)] text-xs">
                No items match the current filter.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
