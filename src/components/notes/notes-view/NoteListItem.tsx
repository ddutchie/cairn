"use client";

import React, { memo } from "react";
import {
  Pin, PinOff, Trash2, MoreHorizontal, FileText,
  Archive, FolderInput, FolderSymlink, LayoutDashboard,
} from "lucide-react";
import { cn, formatRelative } from "@/lib/utils";
import type { Note } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { useCairnStore } from "@/store";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent,
  ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";

export interface NoteListItemProps {
  note: Note; isActive: boolean; indent?: number;
  onClick: () => void; onPin: () => void; onDelete: () => void;
  onArchive: () => void; onMove: () => void; onMoveToFolder: () => void; onReveal: () => void;
  onDragStart?: (noteId: string) => void;
  onDragEnd?: () => void;
}

/** Reveal-in-OS label matching the current platform. */
function revealLabel(): string {
  return window.electron?.platform === "win32"
    ? "Explorer"
    : window.electron?.platform === "linux"
      ? "Files"
      : "Finder";
}

export const NoteListItem = memo(function NoteListItem({ note, isActive, indent = 0, onClick, onPin, onDelete, onArchive, onMove, onMoveToFolder, onReveal, onDragStart, onDragEnd }: NoteListItemProps) {
  const getTagById = useCairnStore((s) => s.getTagById);
  const tags = note.tagIds.slice(0, 3).map((id) => getTagById(id)).filter(Boolean);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
      <div onClick={onClick}
        data-note-id={note.id}
        draggable={!!onDragStart}
        onDragStart={(e) => { e.stopPropagation(); onDragStart?.(note.id); }}
        onDragEnd={(e) => { e.stopPropagation(); onDragEnd?.(); }}
        className={cn("group relative flex flex-col gap-0.5 py-2.5 cursor-pointer transition-colors pr-3",
          isActive ? "bg-[var(--surface-2)] border-l-2 border-[var(--accent)]" : "hover:bg-[var(--surface-2)] border-l-2 border-transparent")}
        style={{ paddingLeft: `${12 + indent}px` }}
      >
        <div className="flex items-center gap-1.5">
          {note.isPinned && <Pin size={9} className="text-[var(--accent)] flex-shrink-0" />}
          {note.type === "dashboard" && <LayoutDashboard size={9} className="text-[var(--text-tertiary)] flex-shrink-0" />}
          <Tooltip content={note.title}>
            <span className={cn("text-xs font-medium truncate flex-1", isActive ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]")}>
              {note.title}
            </span>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button aria-label="Note actions" onClick={(e) => e.stopPropagation()}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-all">
                <MoreHorizontal size={11} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onPin(); }}>
                {note.isPinned ? <PinOff size={12} /> : <Pin size={12} />}
                {note.isPinned ? "Unpin" : "Pin"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onReveal(); }}>
                <FileText size={12} />Reveal in {revealLabel()}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onArchive(); }}>
                <Archive size={12} />Archive
              </DropdownMenuItem>
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onMoveToFolder(); }}>
                <FolderSymlink size={12} />Move to folder
              </DropdownMenuItem>
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onMove(); }}>
                <FolderInput size={12} />Move to project
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDelete(); }} className="text-[var(--danger)] hover:text-[var(--danger)]">
                <Trash2 size={12} />Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <span className="text-[0.786rem] text-[var(--text-tertiary)] truncate">{note.contentText.slice(0, 60) || (note.type === "dashboard" ? "Dashboard" : "Empty note")}</span>
        <div className="flex items-center gap-1.5">
          <span className="text-[0.714rem] text-[var(--text-tertiary)]">{formatRelative(note.updatedAt)}</span>
          {tags.length > 0 && tags.map((tag) => tag && (
            <Badge key={tag.id} color={tag.color} size="xs">{tag.name}</Badge>
          ))}
        </div>
      </div>
      </ContextMenuTrigger>

      {/* Right-click menu — mirrors the hover ⋯ dropdown so both share one action
          set. Radix ContextMenu.Item.onSelect fires after close; no stopPropagation
          needed (the row's onClick doesn't run on a right-click). */}
      <ContextMenuContent>
        <ContextMenuItem onSelect={onPin}>
          {note.isPinned ? <PinOff size={13} /> : <Pin size={13} />}
          {note.isPinned ? "Unpin" : "Pin"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onReveal}>
          <FileText size={13} />Reveal in {revealLabel()}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onArchive}>
          <Archive size={13} />Archive
        </ContextMenuItem>
        <ContextMenuItem onSelect={onMoveToFolder}>
          <FolderSymlink size={13} />Move to folder
        </ContextMenuItem>
        <ContextMenuItem onSelect={onMove}>
          <FolderInput size={13} />Move to project
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onDelete} className="text-[var(--danger)] hover:text-[var(--danger)]">
          <Trash2 size={13} />Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});
