"use client";

import React, { useState } from "react";
import { X } from "lucide-react";
import { useCairnStore } from "@/store";
import { SettingsGroup } from "./shared";

export function TagsSettings() {
  const { tags, notes, cards, activeWorkspaceId, updateTag, deleteTag } = useCairnStore();
  const workspaceTags = tags.filter((t) => t.workspaceId === activeWorkspaceId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  return (
    <SettingsGroup title="Tags" description="Manage workspace tags used on notes and tasks">
      {workspaceTags.length === 0 && (
        <p className="text-sm text-[var(--text-tertiary)]">No tags yet. Create tags from the note editor or card detail.</p>
      )}
      <div className="space-y-1">
        {workspaceTags.map((tag) => {
          const noteCount = notes.filter((n) => n.tagIds.includes(tag.id) && !n.archivedAt).length;
          const cardCount = cards.filter((c) => c.tagIds.includes(tag.id) && !c.archivedAt).length;
          return (
            <div key={tag.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
              <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color }} />
              {editingId === tag.id ? (
                <input
                  autoFocus
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={() => {
                    const trimmed = editValue.trim();
                    if (trimmed && trimmed !== tag.name) updateTag(tag.id, { name: trimmed });
                    setEditingId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  className="flex-1 bg-transparent text-sm text-[var(--text-primary)] outline-none border-b border-[var(--accent)]"
                />
              ) : (
                <span
                  className="flex-1 text-sm text-[var(--text-secondary)] cursor-pointer hover:text-[var(--text-primary)]"
                  onClick={() => { setEditingId(tag.id); setEditValue(tag.name); }}
                >
                  {tag.name}
                </span>
              )}
              <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums">
                {noteCount}n · {cardCount}c
              </span>
              <button
                onClick={() => deleteTag(tag.id)}
                className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-colors"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </SettingsGroup>
  );
}
