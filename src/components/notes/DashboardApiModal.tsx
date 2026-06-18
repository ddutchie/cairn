"use client";

import React, { useState } from "react";
import { HelpCircle, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { ModalShell } from "@/components/ui/modal-shell";

interface ApiEntry {
  signature: string;
  description: string;
  returns: string;
}

const API_ENTRIES: ApiEntry[] = [
  {
    signature: "window.cairn.projectId",
    description: "The ID of the project this dashboard belongs to.",
    returns: "string",
  },
  {
    signature: "window.cairn.workspaceId",
    description: "The ID of the active workspace.",
    returns: "string",
  },
  {
    signature: "window.cairn.listTasks(projectId?)",
    description: "List all task cards grouped by column. Defaults to the current project.",
    returns: "Array<{ columnName, columnType, tasks: Array<{ id, title, priority, dueDate }> }>",
  },
  {
    signature: "window.cairn.listNotes(projectId?)",
    description: "List all notes in a project (title, id, metadata — not full content).",
    returns: "Array<{ id, title, isPinned, updatedAt }>",
  },
  {
    signature: "window.cairn.getProjectSummary(projectId?)",
    description: "Column breakdown, card counts, pinned notes, and recent activity for a project.",
    returns: "{ project, noteCount, totalCards, cardsByColumn, pinnedNotes, recentActivity }",
  },
  {
    signature: "window.cairn.listRecentActivity(opts?)",
    description: "Recently created or updated notes and tasks. Pass { projectId, workspaceId, limit } to filter.",
    returns: "Array<{ type: 'note'|'card', id, title, updatedAt }>",
  },
  {
    signature: "window.cairn.searchTasks(query, projectId?)",
    description: "Full-text search across task cards.",
    returns: "Array<{ id, title, priority, columnType }>",
  },
  {
    signature: "window.cairn.searchNotes(query, projectId?)",
    description: "Full-text search across notes.",
    returns: "Array<{ id, title, snippet }>",
  },
  {
    signature: "window.cairn.getContext()",
    description: "Full workspace context — all projects, column IDs, and tool conventions. Use for workspace-level dashboards.",
    returns: "{ workspaces, projects, tools, conventions }",
  },
  {
    signature: "window.cairn.query(tool, args)",
    description: "Raw bridge — call any allowed read-only tool by name. Use the typed helpers above when possible.",
    returns: "Promise<any>",
  },
  {
    signature: "window._cairnOnRefresh = fn",
    description: "Assign a function here to be called whenever the database changes (MCP write, task move, etc.). Use this to re-fetch and re-render dashboard data without a full reload.",
    returns: "void",
  },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }
  return (
    <button
      onClick={copy}
      className={cn(
        "flex-shrink-0 p-1 rounded transition-colors",
        copied
          ? "text-[var(--success)]"
          : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
      )}
      title="Copy signature"
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}

interface Props {
  onClose: () => void;
}

export function DashboardApiModal({ onClose }: Props) {
  return (
    <ModalShell
      onClose={onClose}
      size="lg"
      scrollable
      title={
        <>
          <HelpCircle size={13} className="text-[var(--text-tertiary)]" />
          <span className="text-sm font-semibold text-[var(--text-primary)]">window.cairn API</span>
          <span className="text-[0.786rem] text-[var(--text-tertiary)] ml-1">available inside every dashboard</span>
        </>
      }
      description="API documentation for window.cairn, available inside every dashboard."
    >
      <div className="divide-y divide-[var(--border)]">
        {API_ENTRIES.map((entry) => (
          <div key={entry.signature} className="px-5 py-3.5 group">
            <div className="flex items-start justify-between gap-3">
              <code className="text-[0.857rem] font-mono text-[var(--accent)] leading-snug flex-1">
                {entry.signature}
              </code>
              <CopyButton text={entry.signature} />
            </div>
            <p className="text-[0.857rem] text-[var(--text-secondary)] mt-1 leading-relaxed">
              {entry.description}
            </p>
            <p className="text-[0.786rem] text-[var(--text-tertiary)] mt-1 font-mono">
              → {entry.returns}
            </p>
          </div>
        ))}
        <div className="px-5 py-3.5 bg-[var(--surface-2)]">
          <p className="text-[0.786rem] text-[var(--text-tertiary)] leading-relaxed">
            <span className="font-semibold text-[var(--text-secondary)]">CSS variables</span>
            {" "}— all Cairn design tokens are available on{" "}
            <code className="font-mono text-[var(--accent)]">:root</code> inside the dashboard:{" "}
            <code className="font-mono">var(--background)</code>,{" "}
            <code className="font-mono">var(--accent)</code>,{" "}
            <code className="font-mono">var(--text-primary)</code>,{" "}
            <code className="font-mono">var(--surface)</code>,{" "}
            <code className="font-mono">var(--border)</code>, and more.
            The <code className="font-mono">data-theme</code> attribute on{" "}
            <code className="font-mono">&lt;html&gt;</code> reflects the active theme
            so <code className="font-mono">[data-theme=&quot;light&quot;]</code> overrides work.
          </p>
        </div>
      </div>
    </ModalShell>
  );
}
