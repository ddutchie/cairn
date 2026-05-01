"use client";

import React, { useMemo, useRef } from "react";
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

// Always produces "MMM DD" (e.g. "Dec 03") for consistent column width
function formatDay(d: Date): string {
  const mon = d.toLocaleDateString(undefined, { month: "short" });
  const day = String(d.getDate()).padStart(2, "0");
  return `${mon} ${day}`;
}

export function TimelineCanvas({ nodes, onNodeClick, selectedNodeId }: Props) {
  const { projects, cards } = useCairnStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Only cards — notes have no temporal meaning in a timeline
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
        const dateDiff = a.due.getTime() - b.due.getTime();
        if (dateDiff !== 0) return dateDiff;
        const ap = PRIORITY_ORDER[(a.card?.priority ?? "medium") as keyof typeof PRIORITY_ORDER] ?? 2;
        const bp = PRIORITY_ORDER[(b.card?.priority ?? "medium") as keyof typeof PRIORITY_ORDER] ?? 2;
        return ap - bp;
      });
  }, [nodes, cards]);

  const undatedCards = useMemo(() =>
    nodes.filter((n) => {
      if (n.type !== "card") return false;
      const card = cards.find((c) => c.id === n.id);
      return !parseDate(card?.dueDate);
    }),
    [nodes, cards]
  );

  if (timedCards.length === 0 && undatedCards.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2">
        <p className="text-xs text-[var(--text-tertiary)]">No tasks with due dates in this scope.</p>
        <p className="text-[11px] text-[var(--text-tertiary)] opacity-60">Add due dates to task cards to see them here.</p>
      </div>
    );
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const projectName = (projectId: string | undefined) =>
    projects.find((p) => p.id === projectId)?.name ?? "";

  // Group timed cards by month, preserving order
  const byMonth = new Map<string, typeof timedCards>();
  for (const item of timedCards) {
    const key = formatMonth(item.due);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key)!.push(item);
  }

  // Find the index where we transition from past to future (for TODAY marker)
  const firstFutureIdx = timedCards.findIndex((x) => x.due >= today);
  const allPast = firstFutureIdx === -1;
  const allFuture = firstFutureIdx === 0;
  const hasTodayMarker = !allPast && timedCards.length > 0;

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto p-6 min-h-0">
      {byMonth.size > 0 && (
        <div className="space-y-8 mb-10 max-w-2xl mx-auto">
          {(() => {
            // Flatten month groups into a renderable list with TODAY marker inserted
            const elements: React.ReactNode[] = [];
            let globalIdx = 0;
            let todayInserted = !hasTodayMarker || allFuture;

            // If all future, show TODAY marker before the first group
            if (allFuture) {
              elements.push(<TodayMarker key="today" />);
              todayInserted = true;
            }

            for (const [month, items] of byMonth.entries()) {
              elements.push(
                <div key={month} className="space-y-1.5">
                  {/* Month header */}
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-[10px] font-semibold text-[var(--text-tertiary)] uppercase tracking-widest">
                      {month}
                    </span>
                    <div className="flex-1 h-px bg-[var(--border)]" />
                  </div>

                  {items.map(({ node, card, due }) => {
                    const isOverdue = due < today;
                    const isToday = due.toDateString() === today.toDateString();
                    const priority = card?.priority ?? "medium";
                    const isSelected = node.id === selectedNodeId;

                    // Insert TODAY marker between last-past and first-future item
                    const insertBefore = !todayInserted && globalIdx === firstFutureIdx;
                    if (insertBefore) todayInserted = true;
                    globalIdx++;

                    return (
                      <React.Fragment key={node.id}>
                        {insertBefore && <TodayMarker />}
                        <button
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
                            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                            style={{ background: PRIORITY_COLOR[priority] }}
                          />

                          {/* Due date — fixed-width monospace for alignment */}
                          <span
                            className={cn(
                              "text-[11px] font-mono w-[52px] flex-shrink-0 text-right",
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
                      </React.Fragment>
                    );
                  })}
                </div>
              );
            }

            return elements;
          })()}
        </div>
      )}

      {/* Undated cards */}
      {undatedCards.length > 0 && (
        <div className="max-w-2xl mx-auto mb-10">
          <div className="flex items-center gap-3 mb-3">
            <span className="text-[10px] font-semibold text-[var(--text-tertiary)] uppercase tracking-widest">
              No due date
            </span>
            <div className="flex-1 h-px bg-[var(--border)]" />
            <span className="text-[10px] text-[var(--text-tertiary)]">{undatedCards.length}</span>
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
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0 opacity-40"
                    style={{ background: PRIORITY_COLOR[priority] }}
                  />
                  {/* Spacer matching the date column width */}
                  <span className="w-[52px] flex-shrink-0" />
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
    </div>
  );
}

function TodayMarker() {
  return (
    <div className="flex items-center gap-3 py-1 my-1">
      <span className="text-[10px] font-semibold text-[var(--warning)] uppercase tracking-widest flex-shrink-0">
        Today
      </span>
      <div className="flex-1 h-px" style={{ background: "var(--warning)", opacity: 0.4 }} />
    </div>
  );
}
