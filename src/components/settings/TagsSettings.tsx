"use client";

import React, { useState, useRef, useEffect } from "react";
import { X, Tag } from "lucide-react";
import { useCairnStore } from "@/store";
import { SettingsGroup } from "./shared";

const PALETTE = [
  "#6366f1", "#8b5cf6", "#a855f7", "#ec4899", "#f43f5e",
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6",
  "#06b6d4", "#3b82f6", "#64748b", "#78716c",
];

export function TagsSettings() {
  const { tags, notes, cards, activeWorkspaceId, updateTag, deleteTag } = useCairnStore();
  const workspaceTags = tags.filter((t) => t.workspaceId === activeWorkspaceId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [colorPickerId, setColorPickerId] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!colorPickerId) return;
    function handle(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setColorPickerId(null);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [colorPickerId]);

  return (
    <SettingsGroup title="Tags" description="Manage workspace tags used on notes and tasks">
      {workspaceTags.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <Tag size={20} className="text-[var(--text-tertiary)] opacity-40" />
          <p className="text-sm text-[var(--text-tertiary)]">No tags yet.</p>
          <p className="text-xs text-[var(--text-tertiary)]">Create tags from the note editor or card detail.</p>
        </div>
      )}
      <div className="space-y-1">
        {workspaceTags.map((tag) => {
          const noteCount = notes.filter((n) => n.tagIds.includes(tag.id) && !n.archivedAt).length;
          const cardCount = cards.filter((c) => c.tagIds.includes(tag.id) && !c.archivedAt).length;
          return (
            <div key={tag.id} className="relative flex items-center gap-3 px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
              {/* Color swatch — click to open palette */}
              <button
                onClick={() => setColorPickerId(colorPickerId === tag.id ? null : tag.id)}
                className="w-3.5 h-3.5 rounded-full flex-shrink-0 ring-1 ring-black/20 hover:ring-2 hover:ring-[var(--accent)] transition-all"
                style={{ backgroundColor: tag.color }}
                title="Change color"
              />

              {/* Color palette popover */}
              {colorPickerId === tag.id && (
                <div
                  ref={pickerRef}
                  className="absolute left-0 top-full mt-1 z-50 p-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] shadow-2xl"
                >
                  <div className="grid grid-cols-7 gap-1.5">
                    {PALETTE.map((color) => (
                      <button
                        key={color}
                        onClick={() => { updateTag(tag.id, { color }); setColorPickerId(null); }}
                        className="w-5 h-5 rounded-full ring-1 ring-black/20 hover:scale-110 transition-transform"
                        style={{ backgroundColor: color }}
                        title={color}
                      />
                    ))}
                  </div>
                </div>
              )}

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
              <span className="text-[0.786rem] text-[var(--text-tertiary)] tabular-nums whitespace-nowrap">
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
