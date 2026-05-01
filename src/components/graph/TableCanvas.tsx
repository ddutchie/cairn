"use client";

import React, { useMemo, useState } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import type { GraphNode, GraphNodeType } from "@/types";
import { nodeTypeColor } from "@/store/slices/graph";

interface Props {
  nodes: GraphNode[];
  onNodeClick: (node: GraphNode) => void;
  selectedNodeId: string | null;
}

type SortKey = "title" | "type" | "project" | "priority" | "updatedAt";
type SortDir = "asc" | "desc";

const TYPE_ORDER: GraphNodeType[] = ["project", "note", "card", "tag"];

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export function TableCanvas({ nodes, onNodeClick, selectedNodeId }: Props) {
  const { projects, notes, cards, tags } = useCairnStore();
  const [sortKey, setSortKey] = useState<SortKey>("type");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [typeFilter, setTypeFilter] = useState<GraphNodeType | "all">("all");
  const [search, setSearch] = useState("");

  const projectName = (id: string | undefined) =>
    id ? (projects.find((p) => p.id === id)?.name ?? "—") : "—";

  // Enrich nodes with extra metadata from store
  const rows = useMemo(() =>
    nodes.map((n) => {
      let priority = "—";
      let updatedAt = "";
      let snippet = n.meta?.snippet ?? "";

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
        snippet = tag?.color ?? "";
      }

      return { node: n, priority, updatedAt, snippet };
    }),
    [nodes, notes, cards, projects, tags]
  );

  // Filter
  const filtered = useMemo(() => {
    let r = rows;
    if (typeFilter !== "all") r = r.filter((x) => x.node.type === typeFilter);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, typeFilter, search]);

  // Sort
  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "title":
          return dir * a.node.title.localeCompare(b.node.title);
        case "type":
          return dir * (TYPE_ORDER.indexOf(a.node.type) - TYPE_ORDER.indexOf(b.node.type));
        case "project":
          return dir * projectName(a.node.projectId).localeCompare(projectName(b.node.projectId));
        case "priority": {
          const pa = PRIORITY_ORDER[a.priority] ?? 4;
          const pb = PRIORITY_ORDER[b.priority] ?? 4;
          return dir * (pa - pb);
        }
        case "updatedAt":
          return dir * a.updatedAt.localeCompare(b.updatedAt);
        default:
          return 0;
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ArrowUpDown size={10} className="text-[var(--text-tertiary)]" />;
    return sortDir === "asc"
      ? <ArrowUp size={10} className="text-[var(--accent)]" />
      : <ArrowDown size={10} className="text-[var(--accent)]" />;
  }

  const ALL_TYPES: GraphNodeType[] = ["project", "note", "card", "tag"];

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Table toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0">
        {/* Search */}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by title, snippet or project…"
          className="flex-1 max-w-72 bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-3 py-1.5 text-xs text-[var(--text-primary)] placeholder-[var(--text-tertiary)] outline-none focus:border-[var(--accent)] transition-colors"
        />

        {/* Type filter pills */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setTypeFilter("all")}
            className={cn(
              "px-2 py-1 rounded text-[11px] transition-colors",
              typeFilter === "all"
                ? "bg-[var(--accent-dim)] text-[var(--accent)]"
                : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]"
            )}
          >
            All
          </button>
          {ALL_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t === typeFilter ? "all" : t)}
              className={cn(
                "px-2 py-1 rounded text-[11px] capitalize transition-colors",
                typeFilter === t
                  ? "text-white"
                  : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]"
              )}
              style={typeFilter === t ? { background: nodeTypeColor(t) } : undefined}
            >
              {t}
            </button>
          ))}
        </div>

        <span className="ml-auto text-[11px] text-[var(--text-tertiary)]">
          {sorted.length} item{sorted.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto min-h-0">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-[var(--surface)] z-10">
            <tr className="border-b border-[var(--border)]">
              {(
                [
                  { key: "type" as SortKey,      label: "Type",     w: "w-20" },
                  { key: "title" as SortKey,     label: "Title",    w: "min-w-48" },
                  { key: "project" as SortKey,   label: "Project",  w: "w-36" },
                  { key: "priority" as SortKey,  label: "Priority", w: "w-24" },
                  { key: "updatedAt" as SortKey, label: "Updated",  w: "w-32" },
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
            {sorted.map(({ node, priority, updatedAt, snippet }) => {
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
                      : "hover:bg-[var(--surface-2)]"
                  )}
                >
                  {/* Type */}
                  <td className="px-3 py-2">
                    <span
                      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium capitalize"
                      style={{
                        color: nodeTypeColor(node.type),
                        background: `color-mix(in srgb, ${nodeTypeColor(node.type)} 12%, transparent)`,
                      }}
                    >
                      {node.type}
                    </span>
                  </td>

                  {/* Title + snippet */}
                  <td className="px-3 py-2 max-w-0">
                    <p className="text-[var(--text-primary)] truncate font-medium">{node.title}</p>
                    {snippet && (
                      <p className="text-[10px] text-[var(--text-tertiary)] truncate mt-0.5">{snippet}</p>
                    )}
                  </td>

                  {/* Project */}
                  <td className="px-3 py-2 text-[var(--text-secondary)] truncate max-w-0">
                    {projectName(node.projectId)}
                  </td>

                  {/* Priority */}
                  <td className="px-3 py-2">
                    {priority !== "—" ? (
                      <span
                        className="inline-flex items-center gap-1 text-[10px] capitalize"
                        style={{
                          color: priority === "urgent" ? "var(--danger)"
                               : priority === "high"   ? "var(--warning)"
                               : priority === "medium" ? "var(--info)"
                               : "var(--success)",
                        }}
                      >
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ background: "currentColor" }}
                        />
                        {priority}
                      </span>
                    ) : (
                      <span className="text-[var(--text-tertiary)]">—</span>
                    )}
                  </td>

                  {/* Updated */}
                  <td className="px-3 py-2 text-[var(--text-tertiary)]">{updated}</td>
                </tr>
              );
            })}

            {sorted.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-[var(--text-tertiary)]">
                  No items match the current filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
