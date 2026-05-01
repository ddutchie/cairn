"use client";

import React, { useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import type { GraphNode } from "@/types";

interface Props {
  nodes: GraphNode[];
  onNodeClick: (node: GraphNode) => void;
  selectedNodeId: string | null;
}

const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };
const PRIORITY_COLOR: Record<string, string> = {
  urgent: "var(--danger)",
  high:   "var(--warning)",
  medium: "var(--info)",
  low:    "var(--success)",
};

function parseDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function formatMonth(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function formatDay(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TimelineCanvas({ nodes, onNodeClick, selectedNodeId }: Props) {
  const { projects, cards } = useCairnStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Only cards with due dates
  const timedCards = useMemo(() => {
    return nodes
      .filter((n) => n.type === "card")
      .map((n) => {
        const card = cards.find((c) => c.id === n.id);
        const due = parseDate(card?.dueDate);
        return { node: n, card, due };
      })
      .filter((x): x is typeof x & { due: Date } => x.due !== null)
      .sort((a, b) => {
        // Sort by due date, then priority
        const dateDiff = a.due.getTime() - b.due.getTime();
        if (dateDiff !== 0) return dateDiff;
        const ap = PRIORITY_ORDER[(a.card?.priority ?? "medium") as keyof typeof PRIORITY_ORDER] ?? 2;
        const bp = PRIORITY_ORDER[(b.card?.priority ?? "medium") as keyof typeof PRIORITY_ORDER] ?? 2;
        return ap - bp;
      });
  }, [nodes, cards]);

  // Cards without due dates (shown in a separate section)
  const undatedCards = useMemo(() =>
    nodes.filter((n) => {
      if (n.type !== "card") return false;
      const card = cards.find((c) => c.id === n.id);
      return !parseDate(card?.dueDate);
    }),
    [nodes, cards]
  );

  // Notes (shown in a flat list section)
  const noteNodes = useMemo(() => nodes.filter((n) => n.type === "note"), [nodes]);

  if (timedCards.length === 0 && undatedCards.length === 0 && noteNodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-xs text-[var(--text-tertiary)]">No items to display in this scope.</p>
      </div>
    );
  }

  // Group timed cards by month
  const byMonth = new Map<string, typeof timedCards>();
  for (const item of timedCards) {
    const key = formatMonth(item.due);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key)!.push(item);
  }

  // Determine today marker position
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const projectName = (projectId: string | undefined) =>
    projects.find((p) => p.id === projectId)?.name ?? "";

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto p-6 min-h-0">
      {/* Timed cards by month */}
      {byMonth.size > 0 && (
        <div className="space-y-8 mb-10">
          {[...byMonth.entries()].map(([month, items]) => (
            <div key={month}>
              <div className="flex items-center gap-3 mb-3">
                <span className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-widest">
                  {month}
                </span>
                <div className="flex-1 h-px bg-[var(--border)]" />
              </div>
              <div className="space-y-1.5">
                {items.map(({ node, card, due }) => {
                  const isOverdue = due < today;
                  const isToday = due.toDateString() === today.toDateString();
                  const priority = card?.priority ?? "medium";
                  const isSelected = node.id === selectedNodeId;

                  return (
                    <button
                      key={node.id}
                      onClick={() => onNodeClick(node)}
                      className={cn(
                        "flex items-center gap-3 w-full px-3 py-2 rounded-lg text-left transition-colors group",
                        isSelected
                          ? "bg-[var(--accent-dim)] border border-[var(--accent)]/30"
                          : "hover:bg-[var(--surface-2)] border border-transparent"
                      )}
                    >
                      {/* Priority dot */}
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ background: PRIORITY_COLOR[priority] }}
                      />

                      {/* Due date badge */}
                      <span
                        className={cn(
                          "text-[11px] font-mono w-20 flex-shrink-0",
                          isOverdue
                            ? "text-[var(--danger)]"
                            : isToday
                            ? "text-[var(--warning)] font-semibold"
                            : "text-[var(--text-tertiary)]"
                        )}
                      >
                        {isToday ? "Today" : formatDay(due)}
                      </span>

                      {/* Title */}
                      <span className="flex-1 text-xs text-[var(--text-primary)] truncate">
                        {node.title}
                      </span>

                      {/* Project pill */}
                      {node.projectId && (
                        <span className="text-[10px] text-[var(--text-tertiary)] bg-[var(--surface-3)] px-1.5 py-0.5 rounded flex-shrink-0">
                          {projectName(node.projectId)}
                        </span>
                      )}

                      {/* Assignee */}
                      {card?.assignee && (
                        <span className="text-[10px] text-[var(--text-tertiary)] flex-shrink-0">
                          {card.assignee}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Undated cards */}
      {undatedCards.length > 0 && (
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-3">
            <span className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-widest">
              No due date
            </span>
            <div className="flex-1 h-px bg-[var(--border)]" />
          </div>
          <div className="space-y-1.5">
            {undatedCards.map((node) => {
              const card = cards.find((c) => c.id === node.id);
              const priority = card?.priority ?? "medium";
              const isSelected = node.id === selectedNodeId;
              return (
                <button
                  key={node.id}
                  onClick={() => onNodeClick(node)}
                  className={cn(
                    "flex items-center gap-3 w-full px-3 py-2 rounded-lg text-left transition-colors",
                    isSelected
                      ? "bg-[var(--accent-dim)] border border-[var(--accent)]/30"
                      : "hover:bg-[var(--surface-2)] border border-transparent"
                  )}
                >
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0 opacity-40"
                    style={{ background: PRIORITY_COLOR[priority] }}
                  />
                  <span className="w-20 flex-shrink-0" />
                  <span className="flex-1 text-xs text-[var(--text-secondary)] truncate">{node.title}</span>
                  {node.projectId && (
                    <span className="text-[10px] text-[var(--text-tertiary)] bg-[var(--surface-3)] px-1.5 py-0.5 rounded flex-shrink-0">
                      {projectName(node.projectId)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Notes section */}
      {noteNodes.length > 0 && (
        <div>
          <div className="flex items-center gap-3 mb-3">
            <span className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-widest">
              Notes
            </span>
            <div className="flex-1 h-px bg-[var(--border)]" />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {noteNodes.map((node) => {
              const isSelected = node.id === selectedNodeId;
              return (
                <button
                  key={node.id}
                  onClick={() => onNodeClick(node)}
                  className={cn(
                    "flex items-start gap-2 px-3 py-2 rounded-lg text-left transition-colors",
                    isSelected
                      ? "bg-[var(--accent-dim)] border border-[var(--accent)]/30"
                      : "hover:bg-[var(--surface-2)] border border-transparent"
                  )}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--info)] mt-1.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs text-[var(--text-primary)] truncate">{node.title}</p>
                    {node.meta?.snippet && (
                      <p className="text-[11px] text-[var(--text-tertiary)] truncate mt-0.5">
                        {node.meta.snippet}
                      </p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
