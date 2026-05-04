"use client";

import React from "react";
import { X, FileText, Kanban, Layers, Hash, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { GraphNode } from "@/types";
import { nodeTypeColor } from "@/store/slices/graph";

interface Props {
  node: GraphNode | null;
  onClose: () => void;
}

export function GraphDetailPanel({ node, onClose }: Props) {
  const { setView, setActiveProject, projects, notes, cards } = useCairnStore(useShallow((s) => ({
    setView:          s.setView,
    setActiveProject: s.setActiveProject,
    projects:         s.projects,
    notes:            s.notes,
    cards:            s.cards,
  })));

  if (!node) return null;

  const project = projects.find((p) => p.id === (node.projectId ?? node.id));

  function navigateTo() {
    if (!node) return;
    const targetProjectId = node.projectId ?? (node.type === "project" ? node.id : null);
    if (targetProjectId) setActiveProject(targetProjectId);

    switch (node.type) {
      case "project":  setView("overview"); break;
      case "note":     setView("notes"); break;
      case "card":     setView("board"); break;
      case "tag":      setView("notes"); break;
    }
    onClose();
  }

  const typeIcon = {
    project: <Layers size={13} />,
    note:    <FileText size={13} />,
    card:    <Kanban size={13} />,
    tag:     <Hash size={13} />,
  }[node.type];

  const typeLabel = {
    project: "Project",
    note:    "Note",
    card:    "Task",
    tag:     "Tag",
  }[node.type];

  // Count linked items from the store for quick context
  const linkedNotes = node.type === "card"
    ? cards.find((c) => c.id === node.id)?.linkedNoteIds.length ?? 0
    : 0;
  const linkedCards = node.type === "note"
    ? notes.find((n) => n.id === node.id)?.linkedCardIds.length ?? 0
    : 0;

  return (
    <div className="w-72 flex-shrink-0 border-l border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="flex items-center gap-1.5 text-xs font-medium px-1.5 py-0.5 rounded"
            style={{
              color: nodeTypeColor(node.type),
              background: `color-mix(in srgb, ${nodeTypeColor(node.type)} 12%, transparent)`,
            }}
          >
            {typeIcon}
            {typeLabel}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
        {/* Title */}
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)] leading-snug">
            {node.title}
          </h3>
          {project && node.type !== "project" && (
            <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
              in {project.name}
            </p>
          )}
        </div>

        {/* Snippet */}
        {node.meta?.snippet && (
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed line-clamp-4">
            {node.meta.snippet}
          </p>
        )}

        {/* Meta fields */}
        <div className="space-y-1.5">
          {node.meta?.status && (
            <MetaRow label="Status" value={node.meta.status} />
          )}
          {node.meta?.priority && (
            <MetaRow label="Priority" value={node.meta.priority} />
          )}
          {node.meta?.assignee && (
            <MetaRow label="Assignee" value={node.meta.assignee} />
          )}
          {node.meta?.color && node.type === "tag" && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-[var(--text-tertiary)] w-16 flex-shrink-0">Colour</span>
              <span
                className="w-3 h-3 rounded-full border border-[var(--border)]"
                style={{ background: node.meta.color }}
              />
            </div>
          )}
          {linkedNotes > 0 && (
            <MetaRow label="Linked notes" value={String(linkedNotes)} />
          )}
          {linkedCards > 0 && (
            <MetaRow label="Linked tasks" value={String(linkedCards)} />
          )}
        </div>
      </div>

      {/* Footer CTA */}
      {node.type !== "tag" && (
        <div className="border-t border-[var(--border)] p-3">
          <button
            onClick={navigateTo}
            className={cn(
              "flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded-md text-xs font-medium transition-colors",
              "bg-[var(--accent-dim)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white"
            )}
          >
            <ExternalLink size={12} />
            Open in {typeLabel === "Task" ? "Board" : typeLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-[var(--text-tertiary)] w-20 flex-shrink-0 capitalize">{label}</span>
      <span className="text-xs text-[var(--text-secondary)] capitalize">{value}</span>
    </div>
  );
}
