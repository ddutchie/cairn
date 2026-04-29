"use client";

import React, { useState } from "react";
import {
  Calendar,
  Tag,
  FileText,
  Link,
  Trash2,
  Flag,
  ExternalLink,
  User,
  Archive,
  Copy,
  X,
  ArrowRight,
  FolderInput,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCairnStore } from "@/store";
import { DatePicker } from "@/components/ui/date-picker";
import { cn, formatRelative, PRIORITY_COLORS } from "@/lib/utils";
import type { Priority } from "@/types";

interface CardDetailModalProps {
  cardId: string;
  onClose: () => void;
}

const PRIORITY_OPTIONS: Priority[] = ["low", "medium", "high", "urgent"];

export function CardDetailModal({ cardId, onClose }: CardDetailModalProps) {
  const {
    cards,
    columns,
    projects,
    notes,
    updateCard,
    deleteCard,
    archiveCard,
    duplicateCard,
    unlinkNoteFromCard,
    moveCardToProject,
    getTagById,
    tags,
    getProjectNotes,
    linkNoteToCard,
    setView,
    activeWorkspaceId,
    getWorkspaceProjects,
  } = useCairnStore();

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [moveToProjectOpen, setMoveToProjectOpen] = useState(false);

  const card = cards.find((c) => c.id === cardId);
  if (!card) return null;

  const column = columns.find((c) => c.id === card.columnId);
  const project = projects.find((p) => p.id === card.projectId);
  // All columns for this project — for moving the card to another column
  const projectColumns = columns
    .filter((c) => c.projectId === card.projectId)
    .sort((a, b) => a.order - b.order);
  const linkedNotes = card.linkedNoteIds.map((nId) => notes.find((n) => n.id === nId)).filter(Boolean);
  const projectNotes = getProjectNotes(card.projectId);
  const projectTags = tags.filter((t) => t.workspaceId === card.workspaceId);
  const otherProjects = (activeWorkspaceId ? getWorkspaceProjects(activeWorkspaceId) : projects)
    .filter((p) => p.id !== card.projectId && !p.archivedAt);

  function handleDelete() {
    deleteCard(cardId);
    onClose();
  }

  function handleArchive() {
    archiveCard(cardId);
    onClose();
  }

  function handleDuplicate() {
    duplicateCard(cardId);
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg" className="flex flex-col max-h-[80vh]">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--text-tertiary)]">
              {project?.name} / {column?.name}
            </span>
          </div>
        </DialogHeader>

        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Main content */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
            {/* Title */}
            <div>
              <input
                type="text"
                defaultValue={card.title}
                onBlur={(e) => updateCard(cardId, { title: e.target.value })}
                className="w-full bg-transparent text-lg font-semibold text-[var(--text-primary)] focus:outline-none border-b border-transparent focus:border-[var(--border)] pb-1 transition-colors"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-2 uppercase tracking-wide">
                Description
              </label>
              <textarea
                defaultValue={card.description ?? ""}
                onBlur={(e) => updateCard(cardId, { description: e.target.value })}
                placeholder="Add a description…"
                rows={4}
                className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2.5 text-sm text-[var(--text-secondary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] resize-none leading-relaxed"
              />
            </div>

            {/* Tags */}
            <div>
              <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-2 uppercase tracking-wide">
                <Tag size={10} className="inline mr-1" />Tags
              </label>
              <div className="flex flex-wrap gap-1.5">
                {projectTags.map((tag) => (
                  <button
                    key={tag.id}
                    onClick={() => {
                      const has = card.tagIds.includes(tag.id);
                      updateCard(cardId, {
                        tagIds: has
                          ? card.tagIds.filter((id) => id !== tag.id)
                          : [...card.tagIds, tag.id],
                      });
                    }}
                    className={cn(
                      "transition-all rounded-md",
                      card.tagIds.includes(tag.id) ? "ring-1 ring-white/20" : "opacity-50 hover:opacity-80"
                    )}
                  >
                    <Badge color={tag.color}>{tag.name}</Badge>
                  </button>
                ))}
              </div>
            </div>

            {/* Linked notes */}
            <div>
              <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-2 uppercase tracking-wide">
                <FileText size={10} className="inline mr-1" />Linked Notes
              </label>
              <div className="space-y-2">
                {linkedNotes.map(
                  (note) =>
                    note && (
                      <div
                        key={note.id}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] group"
                      >
                        <FileText size={12} className="text-[var(--text-tertiary)] flex-shrink-0" />
                        <span className="text-xs text-[var(--text-secondary)] flex-1 truncate">
                          {note.title}
                        </span>
                        <button
                          onClick={() => setView("notes")}
                          className="opacity-0 group-hover:opacity-100 text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-all"
                          title="Open note"
                        >
                          <ExternalLink size={11} />
                        </button>
                        <button
                          onClick={() => unlinkNoteFromCard(note.id, cardId)}
                          className="opacity-0 group-hover:opacity-100 text-[var(--text-tertiary)] hover:text-red-400 transition-all"
                          title="Unlink note"
                        >
                          <X size={11} />
                        </button>
                      </div>
                    )
                )}
                {projectNotes.filter((n) => !card.linkedNoteIds.includes(n.id)).length > 0 && (
                  <details className="group">
                    <summary className="text-xs text-[var(--text-tertiary)] cursor-pointer hover:text-[var(--accent)] transition-colors list-none flex items-center gap-1">
                      <Link size={10} />
                      Link a note…
                    </summary>
                    <div className="mt-2 space-y-1 pl-3 border-l border-[var(--border)]">
                      {projectNotes
                        .filter((n) => !card.linkedNoteIds.includes(n.id))
                        .map((note) => (
                          <button
                            key={note.id}
                            onClick={() => linkNoteToCard(note.id, cardId)}
                            className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors text-left"
                          >
                            <FileText size={10} />
                            {note.title}
                          </button>
                        ))}
                    </div>
                  </details>
                )}
                {linkedNotes.length === 0 && projectNotes.length === 0 && (
                  <p className="text-xs text-[var(--text-tertiary)]">No notes in this project yet</p>
                )}
              </div>
            </div>
          </div>

          {/* Sidebar metadata */}
          <div className="w-44 flex-shrink-0 border-l border-[var(--border)] px-4 py-4 space-y-4 overflow-y-auto">
            {/* Priority */}
            <div>
              <label className="block text-[10px] font-semibold text-[var(--text-tertiary)] mb-2 uppercase tracking-wider">
                Priority
              </label>
              <div className="space-y-1">
                {PRIORITY_OPTIONS.map((p) => (
                  <button
                    key={p}
                    onClick={() => updateCard(cardId, { priority: p })}
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs transition-colors",
                      card.priority === p
                        ? "bg-[var(--surface-3)] text-[var(--text-primary)]"
                        : "text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]"
                    )}
                  >
                    <Flag
                      size={10}
                      className={PRIORITY_COLORS[p]}
                      fill={card.priority === p ? "currentColor" : "none"}
                    />
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {/* Move to column */}
            <div>
              <label className="block text-[10px] font-semibold text-[var(--text-tertiary)] mb-2 uppercase tracking-wider">
                <ArrowRight size={9} className="inline mr-0.5" />Column
              </label>
              <select
                value={card.columnId}
                onChange={(e) => updateCard(cardId, { columnId: e.target.value })}
                className="w-full px-2 py-1.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-xs text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)]"
              >
                {projectColumns.map((col) => (
                  <option key={col.id} value={col.id}>{col.name}</option>
                ))}
              </select>
            </div>

            {/* Assignee */}
            <div>
              <label className="block text-[10px] font-semibold text-[var(--text-tertiary)] mb-2 uppercase tracking-wider">
                <User size={9} className="inline mr-0.5" />Assignee
              </label>
              <input
                type="text"
                defaultValue={card.assignee ?? ""}
                onBlur={(e) => updateCard(cardId, { assignee: e.target.value || undefined })}
                placeholder="Unassigned"
                className="w-full px-2 py-1.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-xs text-[var(--text-secondary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
              />
            </div>

            {/* Due date */}
            <div>
              <label className="block text-[10px] font-semibold text-[var(--text-tertiary)] mb-2 uppercase tracking-wider">
                <Calendar size={9} className="inline mr-0.5" />Due Date
              </label>
              <DatePicker
                value={card.dueDate}
                onChange={(v) => updateCard(cardId, { dueDate: v })}
              />
            </div>

            {/* Meta */}
            <div className="pt-2 border-t border-[var(--border)] space-y-1">
              <div className="text-[10px] text-[var(--text-tertiary)]">
                Created {formatRelative(card.createdAt)}
              </div>
              <div className="text-[10px] text-[var(--text-tertiary)]">
                Updated {formatRelative(card.updatedAt)}
              </div>
            </div>

            {/* Actions */}
            <div className="pt-2 space-y-1.5">
              <Button
                variant="ghost"
                size="xs"
                className="w-full justify-start text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                onClick={handleDuplicate}
              >
                <Copy size={10} />
                Duplicate
              </Button>
              <Button
                variant="ghost"
                size="xs"
                className="w-full justify-start text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                onClick={handleArchive}
              >
                <Archive size={10} />
                Archive
              </Button>
              {otherProjects.length > 0 && (
                <div>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="w-full justify-start text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    onClick={() => setMoveToProjectOpen((o) => !o)}
                  >
                    <FolderInput size={10} />
                    Move to project
                  </Button>
                  {moveToProjectOpen && (
                    <div className="mt-1 space-y-0.5 pl-1 border-l border-[var(--border)]">
                      {otherProjects.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => { moveCardToProject(cardId, p.id); onClose(); }}
                          className="w-full text-left px-2 py-1 rounded text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors truncate"
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="border-t border-[var(--border)] pt-1.5">
                {confirmDelete ? (
                  <div className="space-y-1">
                    <p className="text-[10px] text-[var(--text-tertiary)]">Are you sure?</p>
                    <div className="flex gap-1">
                      <Button variant="danger" size="xs" onClick={handleDelete}>Delete</Button>
                      <Button variant="ghost" size="xs" onClick={() => setConfirmDelete(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="w-full justify-start text-[var(--danger)] hover:bg-[var(--danger)]/10"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 size={10} />
                    Delete
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
