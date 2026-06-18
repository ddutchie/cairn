"use client";

import React, { useState, useMemo } from "react";
import {
  Tag, FileText, Link, ExternalLink, X,
} from "lucide-react";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { SpawnAgentModal } from "@/components/agent/SpawnAgentModal";
import { MarkdownContent } from "@/components/chat/chat-panel/MarkdownContent";
import { CardDetailSidebar } from "./card-detail-sidebar";

interface CardDetailModalProps {
  cardId: string;
  onClose: () => void;
}

export function CardDetailModal({ cardId, onClose }: CardDetailModalProps) {
  const {
    cards, columns, projects, notes,
    updateCard, deleteCard, archiveCard, duplicateCard,
    unlinkNoteFromCard, moveCardToProject,
    addCardBlocker, removeCardBlocker,
    tags, getProjectNotes, linkNoteToCard,
    setView, activeWorkspaceId, getWorkspaceProjects,
  } = useCairnStore(useShallow((s) => ({
    cards: s.cards, columns: s.columns, projects: s.projects, notes: s.notes,
    updateCard: s.updateCard, deleteCard: s.deleteCard, archiveCard: s.archiveCard,
    duplicateCard: s.duplicateCard, unlinkNoteFromCard: s.unlinkNoteFromCard,
    moveCardToProject: s.moveCardToProject, addCardBlocker: s.addCardBlocker,
    removeCardBlocker: s.removeCardBlocker, tags: s.tags,
    getProjectNotes: s.getProjectNotes, linkNoteToCard: s.linkNoteToCard,
    setView: s.setView, activeWorkspaceId: s.activeWorkspaceId,
    getWorkspaceProjects: s.getWorkspaceProjects,
  })));

  const [spawnAgentOpen, setSpawnAgentOpen] = useState(false);
  const [isEditingDesc, setIsEditingDesc] = useState(false);

  const card = useMemo(() => cards.find((c) => c.id === cardId), [cards, cardId]);
  const column         = useMemo(() => card ? columns.find((c) => c.id === card.columnId) : undefined, [card, columns]);
  const project        = useMemo(() => card ? projects.find((p) => p.id === card.projectId) : undefined, [card, projects]);
  const projectColumns = useMemo(() => card ? columns.filter((c) => c.projectId === card.projectId).sort((a, b) => a.order - b.order) : [], [card, columns]);
  const linkedNotes    = useMemo(() => card ? card.linkedNoteIds.map((nId) => notes.find((n) => n.id === nId)).filter(Boolean) : [], [card, notes]);
  const projectNotes   = useMemo(() => card ? getProjectNotes(card.projectId) : [], [card, getProjectNotes]);
  const projectTags    = useMemo(() => card ? tags.filter((t) => t.workspaceId === card.workspaceId) : [], [card, tags]);
  const otherProjects  = useMemo(() => card ? (activeWorkspaceId ? getWorkspaceProjects(activeWorkspaceId) : projects).filter((p) => p.id !== card.projectId && !p.archivedAt) : [], [card, activeWorkspaceId, getWorkspaceProjects, projects]);

  if (!card) return null;

  const doneColumnIds = new Set(columns.filter((c) => c.projectId === card.projectId && c.type === "done").map((c) => c.id));
  const blockerCards = (card.blockedByIds ?? []).map((id) => cards.find((c) => c.id === id)).filter(Boolean) as typeof cards;
  const candidateBlockers = cards.filter(
    (c) => c.projectId === card.projectId && c.id !== cardId && !c.archivedAt
      && !doneColumnIds.has(c.columnId) && !(card.blockedByIds ?? []).includes(c.id)
  );

  return (
    <>
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg" className="flex flex-col max-h-[80vh]">
        <DialogHeader>
          <VisuallyHidden.Root>
            <DialogTitle>{card.title}</DialogTitle>
          </VisuallyHidden.Root>
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
                className="w-full bg-transparent text-lg font-semibold text-[var(--text-primary)] focus:outline-none border-b border-[var(--border-subtle)] hover:border-[var(--border)] focus:border-[var(--accent)] pb-1 transition-colors"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-2 uppercase tracking-wide">Description</label>
              {isEditingDesc ? (
                <textarea
                  autoFocus
                  defaultValue={card.description ?? ""}
                  onBlur={(e) => {
                    updateCard(cardId, { description: e.target.value });
                    setIsEditingDesc(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      e.currentTarget.blur();
                    }
                  }}
                  placeholder="Add a description…"
                  rows={8}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2.5 text-sm text-[var(--text-secondary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] resize-none leading-relaxed min-h-[12rem]"
                />
              ) : (
                <div
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a, button")) return;
                    setIsEditingDesc(true);
                  }}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border)] hover:border-[color-mix(in_srgb,var(--accent)_40%,transparent)] rounded-lg px-3 py-2.5 text-sm text-[var(--text-secondary)] min-h-[12rem] cursor-pointer transition-colors overflow-y-auto"
                >
                  {card.description?.trim() ? (
                    <MarkdownContent content={card.description} />
                  ) : (
                    <span className="text-[var(--text-tertiary)] italic">Add a description…</span>
                  )}
                </div>
              )}
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
                      "transition-all rounded focus-visible:outline-none",
                      !card.tagIds.includes(tag.id) && "opacity-50 hover:opacity-80"
                    )}
                  >
                    <Badge
                      color={tag.color}
                      className={card.tagIds.includes(tag.id) ? "opacity-100" : undefined}
                      style={card.tagIds.includes(tag.id) ? {
                        borderColor: tag.color ? `color-mix(in srgb, ${tag.color} 60%, transparent)` : "var(--accent)",
                      } : undefined}
                    >{tag.name}</Badge>
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
                {linkedNotes.map((note) => note && (
                  <div key={note.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] group">
                    <FileText size={12} className="text-[var(--text-tertiary)] flex-shrink-0" />
                    <span className="text-xs text-[var(--text-secondary)] flex-1 truncate">{note.title}</span>
                    <button onClick={() => setView("notes")} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-all" aria-label="Open note">
                      <ExternalLink size={11} aria-hidden="true" />
                    </button>
                    <button onClick={() => unlinkNoteFromCard(note.id, cardId)} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-all" aria-label="Unlink note">
                      <X size={11} aria-hidden="true" />
                    </button>
                  </div>
                ))}
                {projectNotes.filter((n) => !card.linkedNoteIds.includes(n.id)).length > 0 && (
                  <details className="group">
                    <summary className="text-xs text-[var(--text-tertiary)] cursor-pointer hover:text-[var(--accent)] transition-colors list-none flex items-center gap-1">
                      <Link size={10} /> Link a note…
                    </summary>
                    <div className="mt-2 space-y-1 pl-3 border-l border-[var(--border)]">
                      {projectNotes.filter((n) => !card.linkedNoteIds.includes(n.id)).map((note) => (
                        <button key={note.id} onClick={() => linkNoteToCard(note.id, cardId)}
                          className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors text-left">
                          <FileText size={10} /> {note.title}
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
          <CardDetailSidebar
            card={card}
            columns={columns}
            projectColumns={projectColumns}
            otherProjects={otherProjects}
            blockerCards={blockerCards}
            candidateBlockers={candidateBlockers}
            doneColumnIds={doneColumnIds}
            onUpdateCard={updateCard}
            onAddBlocker={addCardBlocker}
            onRemoveBlocker={removeCardBlocker}
            onMoveToProject={(cardId, projectId) => { moveCardToProject(cardId, projectId); onClose(); }}
            onArchive={() => { archiveCard(cardId); onClose(); }}
            onDuplicate={() => { duplicateCard(cardId); onClose(); }}
            onDelete={() => { deleteCard(cardId); onClose(); }}
            onSpawnAgent={() => setSpawnAgentOpen(true)}
          />
        </div>
      </DialogContent>
    </Dialog>

    {/* Spawn Agent Modal */}
    {spawnAgentOpen && card && (
      <SpawnAgentModal card={card} open={spawnAgentOpen} onClose={() => setSpawnAgentOpen(false)} />
    )}
    </>
  );
}
