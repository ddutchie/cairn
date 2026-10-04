"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCairnStore } from "@/store";
import { cn } from "@/lib/utils";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import type { BoardColumn, ID } from "@/types";

type CaptureKind = "task" | "note";

/** Backlog first, then To Do, then the left-most column. */
export function captureColumn(columns: readonly BoardColumn[]): BoardColumn | undefined {
  const sorted = [...columns].sort((a, b) => a.order - b.order);
  return sorted.find((c) => c.type === "backlog") ?? sorted.find((c) => c.type === "todo") ?? sorted[0];
}

/**
 * Quick Capture — opened by the global shortcut (⌘⇧Space / Ctrl⇧Space) or the
 * tray menu. Adds a backlog card or a note to any project in the active
 * workspace without navigating away from what's open.
 */
export function QuickCapture() {
  const { activeWorkspaceId, activeProjectId, projects, getProjectColumns, createCard, updateCard, createNote } =
    useCairnStore(useShallow((s) => ({
      activeWorkspaceId: s.activeWorkspaceId,
      activeProjectId: s.activeProjectId,
      projects: s.projects,
      getProjectColumns: s.getProjectColumns,
      createCard: s.createCard,
      updateCard: s.updateCard,
      createNote: s.createNote,
    })));

  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<CaptureKind>("task");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [projectId, setProjectId] = useState<ID | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const workspaceProjects = useMemo(
    () => projects.filter((p) => p.workspaceId === activeWorkspaceId && !p.archivedAt),
    [projects, activeWorkspaceId],
  );

  useEffect(() => {
    return window.electron?.onQuickCapture?.(() => {
      setOpen(true);
      setSaved(null);
      setProjectId((cur) => cur ?? activeProjectId);
      // Focus after the dialog mounts / the window regains focus.
      setTimeout(() => titleRef.current?.focus(), 50);
    });
  }, [activeProjectId]);

  const targetProject = projectId ?? activeProjectId ?? workspaceProjects[0]?.id ?? null;
  const column = targetProject ? captureColumn(getProjectColumns(targetProject)) : undefined;
  const canSave = title.trim() !== "" && !!targetProject && (kind === "note" || !!column);

  const close = () => {
    setOpen(false);
    setTitle("");
    setBody("");
  };

  const save = (keepOpen: boolean) => {
    if (!canSave || !targetProject) return;
    const name = title.trim();
    if (kind === "task") {
      const card = createCard(column!.id, targetProject, name);
      if (body.trim()) updateCard(card.id, { description: body.trim() });
      setSaved(`Added “${name}” to ${column!.name}`);
    } else {
      createNote(targetProject, name, "note", "", body.trim());
      setSaved(`Created note “${name}”`);
    }
    setTitle("");
    setBody("");
    if (keepOpen) titleRef.current?.focus();
    else setOpen(false);
  };

  if (!open) return null;

  return (
    <ModalShell
      open={open}
      onClose={close}
      size="sm"
      title="Quick capture"
      description="Add a card or note to a project"
      footer={
        <div className="flex items-center justify-between w-full gap-2">
          <span className="text-[0.714rem] text-[var(--text-tertiary)] truncate">
            {saved ?? (kind === "task" && column ? `→ ${column.name}` : "↵ save · ⇧↵ save & add another")}
          </span>
          <div className="flex gap-2">
            <Button variant="default" size="sm" onClick={close}>Close</Button>
            <Button variant="accent" size="sm" disabled={!canSave} onClick={() => save(false)}>
              {kind === "task" ? "Add card" : "Create note"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3 px-5 pt-1 pb-2">
        <div className="flex items-center gap-2">
          <div role="radiogroup" aria-label="Capture type" className="flex rounded-md border border-[var(--border)] overflow-hidden">
            {(["task", "note"] as const).map((k) => (
              <button
                key={k}
                role="radio"
                aria-checked={kind === k}
                onClick={() => setKind(k)}
                className={cn(
                  "px-3 py-1 text-xs capitalize transition-colors",
                  kind === k ? "bg-[var(--surface-2)] text-[var(--text-primary)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]",
                )}
              >
                {k === "task" ? "Card" : "Note"}
              </button>
            ))}
          </div>
          <select
            aria-label="Project"
            value={targetProject ?? ""}
            onChange={(e) => setProjectId(e.target.value || null)}
            className="flex-1 min-w-0 px-2 py-1 text-xs rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
          >
            {workspaceProjects.map((p) => (
              <option key={p.id} value={p.id}>{p.icon ? `${p.icon} ` : ""}{p.name}</option>
            ))}
          </select>
        </div>
        <input
          ref={titleRef}
          autoFocus
          value={title}
          onChange={(e) => { setTitle(e.target.value); setSaved(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(e.shiftKey); } }}
          placeholder={kind === "task" ? "What needs doing?" : "Note title"}
          className="w-full px-3 py-2 text-sm rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(false); } }}
          rows={3}
          placeholder={kind === "task" ? "Details (optional)" : "Body (optional, markdown)"}
          className="w-full px-3 py-2 text-xs rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] resize-none"
        />
        {kind === "task" && targetProject && !column && (
          <p className="text-[0.714rem] text-[var(--warning)]">This project has no board columns yet.</p>
        )}
      </div>
    </ModalShell>
  );
}
