"use client";

import React, { useState } from "react";
import { X, Tag } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { SettingsGroup } from "./shared";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TAG_PALETTE } from "@/lib/constants";


export function TagsSettings() {
  const { tags, notes, cards, activeWorkspaceId, updateTag, deleteTag } = useCairnStore(useShallow((s) => ({ tags: s.tags, notes: s.notes, cards: s.cards, activeWorkspaceId: s.activeWorkspaceId, updateTag: s.updateTag, deleteTag: s.deleteTag })));
  const workspaceTags = tags.filter((t) => t.workspaceId === activeWorkspaceId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [colorPickerId, setColorPickerId] = useState<string | null>(null);

  return (
    <SettingsGroup title="Workspace tags" description="Click a name to rename it, or the dot to change its colour.">
      {workspaceTags.length === 0 && (
        <EmptyState
          icon={Tag}
          title="No tags yet."
          description="Create tags from the note editor or card detail."
          className="py-6"
        />
      )}
      <div className="space-y-1">
        {workspaceTags.map((tag) => {
          const noteCount = notes.filter((n) => n.tagIds.includes(tag.id) && !n.archivedAt).length;
          const cardCount = cards.filter((c) => c.tagIds.includes(tag.id) && !c.archivedAt).length;
          return (
            <div key={tag.id} className="relative flex items-center gap-3 px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
              {/* Color swatch — click to open palette */}
              <Popover open={colorPickerId === tag.id} onOpenChange={(open) => setColorPickerId(open ? tag.id : null)}>
                <PopoverTrigger asChild>
                  <button
                    aria-label={`Change color of ${tag.name}`}
                    className="w-3.5 h-3.5 rounded-full flex-shrink-0 ring-1 ring-[color-mix(in_srgb,var(--text-primary)_20%,transparent)] hover:ring-2 hover:ring-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] transition-all"
                    style={{ backgroundColor: tag.color }}
                    title="Change color"
                  />
                </PopoverTrigger>
                <PopoverContent className="p-2">
                  <div className="grid grid-cols-7 gap-1.5">
                    {TAG_PALETTE.map(({ color, name }) => (
                      <button
                        key={color}
                        onClick={() => { updateTag(tag.id, { color }); setColorPickerId(null); }}
                        className="w-5 h-5 rounded-full ring-1 ring-[color-mix(in_srgb,var(--text-primary)_20%,transparent)] hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] transition-transform"
                        style={{ backgroundColor: color }}
                        title={name}
                        aria-label={`Set color to ${name}`}
                      />
                    ))}
                  </div>
                </PopoverContent>
              </Popover>

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
              <span className="text-sm text-[var(--text-tertiary)] tabular-nums whitespace-nowrap">
                {noteCount} note{noteCount !== 1 ? "s" : ""} · {cardCount} card{cardCount !== 1 ? "s" : ""}
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
