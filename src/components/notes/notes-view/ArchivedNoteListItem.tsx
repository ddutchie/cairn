"use client";

import React from "react";
import { Trash2, MoreHorizontal, ArchiveRestore } from "lucide-react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent,
  ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import type { Note } from "@/types";
import { IconButton } from "@/components/ui/icon-button";

export function ArchivedNoteListItem({ note, onRestore, onDelete }: { note: Note; onRestore: () => void; onDelete: () => void }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
      <div className="group flex items-center gap-1.5 px-3 py-2">
        <span className="flex-1 text-sm text-[var(--text-tertiary)] truncate">{note.title}</span>
        <IconButton
          label="Restore note" tooltipSide="top"
          onClick={(e) => { e.stopPropagation(); onRestore(); }}
          className="size-auto opacity-0 group-hover:opacity-100 p-0.5 text-[var(--text-tertiary)] hover:text-[var(--accent)] hover:bg-[var(--accent-dim)] transition-all"
        >
          <ArchiveRestore size={11} />
        </IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              label="More options"
              onClick={(e) => e.stopPropagation()}
              className="size-auto opacity-0 group-hover:opacity-100 p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-all"
            >
              <MoreHorizontal size={11} />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onRestore(); }}>
              <ArchiveRestore size={12} />Restore
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDelete(); }} className="text-[var(--danger)] hover:text-[var(--danger)]">
              <Trash2 size={12} />Delete permanently
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onRestore}>
          <ArchiveRestore size={13} />Restore
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onDelete} className="text-[var(--danger)] hover:text-[var(--danger)]">
          <Trash2 size={13} />Delete permanently
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
