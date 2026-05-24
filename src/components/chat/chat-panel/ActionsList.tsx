"use client";

import React, { useState } from "react";
import { X, Loader2, Link2, FileText, Kanban, Tag, Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { SuggestedAction } from "@/types";
import { wikilinkAlreadyExists } from "@/components/graph/graph-ai-utils";

function actionIcon(type: SuggestedAction["type"]) {
  switch (type) {
    case "add_wikilink":   return <Link2 size={11} className="text-[var(--accent)] shrink-0" />;
    case "link_note_note": return <FileText size={11} className="text-[var(--info)] shrink-0" />;
    case "link_note_card": return <Kanban size={11} className="text-[var(--success)] shrink-0" />;
    case "add_tag":        return <Tag size={11} className="text-[var(--warning)] shrink-0" />;
  }
}

function actionLabel(action: SuggestedAction): string {
  // Defensive fallbacks to handle minor field naming variations from small on-device models
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = action as any;
  const sourceTitle = a.sourceTitle || a.noteTitle || a.nodeTitle || "undefined";
  const targetTitle = a.targetTitle || a.cardTitle || a.noteTitle || "undefined";

  switch (action.type) {
    case "add_wikilink":   return `Add [[${targetTitle}]] → "${sourceTitle}"`;
    case "link_note_note": return `Link "${sourceTitle}" ↔ "${targetTitle}"`;
    case "link_note_card": return `Link "${sourceTitle}" → "${targetTitle}"`;
    case "add_tag":        return `Tag "${sourceTitle}" #${a.tagName}`;
  }
}

interface ActionCardProps {
  action: SuggestedAction;
  state: "idle" | "applying" | "done";
  onApply: () => Promise<void>;
  onDismiss: () => void;
}

function ActionCard({ action, state, onApply, onDismiss }: ActionCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={cn(
      "rounded-lg border text-[0.714rem] overflow-hidden transition-colors",
      state === "done"
        ? "border-[var(--success)]/30 bg-[color-mix(in_srgb,var(--success)_6%,transparent)]"
        : "border-[var(--border)] bg-[var(--surface)]"
    )}>
      <div className="flex items-center gap-2 px-2.5 py-2">
        {actionIcon(action.type)}
        <span className={cn(
          "flex-1 min-w-0 leading-snug",
          state === "done" ? "text-[var(--text-tertiary)] line-through truncate" : "text-[var(--text-secondary)]"
        )}>
          {actionLabel(action)}
        </span>

        <button
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
          title="Why?"
        >
          {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        </button>

        {state === "done" ? (
          <Check size={11} className="text-[var(--success)] shrink-0" />
        ) : (
          <button
            onClick={onApply}
            disabled={state === "applying"}
            className="shrink-0 px-2 py-0.5 rounded bg-[var(--accent-dim)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] transition-colors disabled:opacity-50 text-[0.643rem] font-medium"
          >
            {state === "applying" ? <Loader2 size={9} className="animate-spin" /> : "Apply"}
          </button>
        )}

        {state !== "done" && (
          <button
            onClick={onDismiss}
            className="shrink-0 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            title="Dismiss"
          >
            <X size={10} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="px-2.5 pb-2 pt-1.5 text-[0.643rem] text-[var(--text-tertiary)] leading-relaxed border-t border-[var(--border)]">
          {action.reason}
        </div>
      )}
    </div>
  );
}

interface ActionsListProps {
  actions: SuggestedAction[];
}

export function ActionsList({ actions }: ActionsListProps) {
  const {
    notes, cards, tags, activeWorkspaceId,
    updateNote, updateCard, linkNoteToCard, createTag, recomputeGraphRelationshipsIncremental,
  } = useCairnStore(useShallow((s) => ({
    notes:                                  s.notes,
    cards:                                  s.cards,
    tags:                                   s.tags,
    activeWorkspaceId:                      s.activeWorkspaceId,
    updateNote:                             s.updateNote,
    updateCard:                             s.updateCard,
    linkNoteToCard:                         s.linkNoteToCard,
    createTag:                              s.createTag,
    recomputeGraphRelationshipsIncremental: s.recomputeGraphRelationshipsIncremental,
  })));

  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [cardStates, setCardStates] = useState<Map<number, "idle" | "applying" | "done">>(() => new Map());
  const [applyAllState, setApplyAllState] = useState<"idle" | "applying" | "done">("idle");

  function setCardState(i: number, state: "idle" | "applying" | "done") {
    setCardStates((prev) => new Map(prev).set(i, state));
  }

  async function applyAction(action: SuggestedAction) {
    const affectedIds: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = action as any;
    
    // Resolve primary entity IDs defensively
    const sourceNoteId = a.sourceNoteId || a.noteId || a.nodeId;
    const targetNoteId = a.targetNoteId || a.cardId || a.nodeId;
    const noteId = a.noteId || a.sourceNoteId || a.nodeId;
    const cardId = a.cardId || a.targetNoteId;
    const nodeId = a.nodeId || a.sourceNoteId || a.noteId;

    switch (action.type) {
      case "add_wikilink": {
        const note = notes.find((n) => n.id === sourceNoteId);
        if (!note) throw new Error("Note not found");
        const targetTitle = a.targetTitle || a.cardTitle || a.noteTitle || "";
        const existing = note.content ?? "";
        if (wikilinkAlreadyExists(existing, targetTitle)) break;
        updateNote(sourceNoteId, { content: existing + `\n\n[[${targetTitle}]]` });
        affectedIds.push(sourceNoteId);
        break;
      }
      case "link_note_note": {
        const src = notes.find((n) => n.id === sourceNoteId);
        const tgt = notes.find((n) => n.id === targetNoteId);
        if (!src || !tgt) throw new Error("Note not found");
        updateNote(sourceNoteId, { linkedNoteIds: Array.from(new Set([...src.linkedNoteIds, targetNoteId])) });
        updateNote(targetNoteId, { linkedNoteIds: Array.from(new Set([...tgt.linkedNoteIds, sourceNoteId])) });
        affectedIds.push(sourceNoteId, targetNoteId);
        break;
      }
      case "link_note_card": {
        if (!noteId || !cardId) throw new Error("IDs missing");
        linkNoteToCard(noteId, cardId);
        affectedIds.push(noteId, cardId);
        break;
      }
      case "add_tag": {
        if (!activeWorkspaceId) throw new Error("No workspace");
        if (!nodeId) throw new Error("Node ID missing");
        const existingTag = tags.find((t) => t.name.toLowerCase() === action.tagName.toLowerCase());
        const tag = existingTag ?? createTag(activeWorkspaceId, action.tagName);
        if (action.nodeType === "note") {
          const note = notes.find((n) => n.id === nodeId);
          if (note) updateNote(nodeId, { tagIds: Array.from(new Set([...note.tagIds, tag.id])) });
        } else {
          const card = cards.find((c) => c.id === nodeId);
          if (card) updateCard(nodeId, { tagIds: Array.from(new Set([...card.tagIds, tag.id])) });
        }
        affectedIds.push(nodeId);
        break;
      }
    }
    if (activeWorkspaceId && affectedIds.length > 0) {
      recomputeGraphRelationshipsIncremental(activeWorkspaceId, affectedIds).catch(() => {});
    }
  }

  async function handleApplyAll() {
    setApplyAllState("applying");
    for (let i = 0; i < actions.length; i++) {
      if (dismissed.has(i)) continue;
      setCardState(i, "applying");
      try {
        await applyAction(actions[i]);
        setCardState(i, "done");
      } catch {
        setCardState(i, "idle");
      }
    }
    setApplyAllState("done");
  }

  const visible = actions.filter((_, i) => !dismissed.has(i));
  if (visible.length === 0) return null;

  return (
    <div className="mt-2 space-y-1.5 w-full">
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[0.643rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wide">
          {visible.length} suggested action{visible.length !== 1 ? "s" : ""}
        </span>
        {visible.length > 1 && applyAllState === "idle" && (
          <button onClick={handleApplyAll} className="text-[0.643rem] text-[var(--accent)] hover:underline">
            Apply all
          </button>
        )}
        {applyAllState === "done" && (
          <span className="text-[0.643rem] text-[var(--success)] flex items-center gap-1">
            <Check size={9} /> All applied
          </span>
        )}
      </div>
      {actions.map((action, i) =>
        dismissed.has(i) ? null : (
          <ActionCard
            key={i}
            action={action}
            state={cardStates.get(i) ?? "idle"}
            onApply={async () => {
              setCardState(i, "applying");
              try {
                await applyAction(action);
                setCardState(i, "done");
              } catch {
                setCardState(i, "idle");
              }
            }}
            onDismiss={() => setDismissed((prev) => new Set([...prev, i]))}
          />
        )
      )}
    </div>
  );
}
