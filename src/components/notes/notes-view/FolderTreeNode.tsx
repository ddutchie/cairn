"use client";

import React, { memo } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Note } from "@/types";
import { Tooltip } from "@/components/ui/tooltip";
import { NoteListItem } from "./NoteListItem";
import type { FolderNode } from "./buildFolderTree";

export interface FolderTreeNodeProps {
  node: FolderNode;
  activeNoteId: string | null;
  collapsed: Record<string, boolean>;
  depth?: number;
  onToggle: (path: string) => void;
  onNoteClick: (id: string) => void;
  onNotePin: (note: Note) => void;
  onNoteDelete: (note: Note) => void;
  onNoteArchive: (note: Note) => void;
  onNoteMove: (note: Note) => void;
  onNoteMoveToFolder: (note: Note) => void;
  onNoteReveal: (note: Note) => void;
  onCreateInFolder: (folder: string) => void;
  dropTarget: string | null;
  onNoteDragStart: (noteId: string) => void;
  onNoteDragEnd: () => void;
  onFolderDragStart: (folderPath: string) => void;
  onFolderDragEndSource: () => void;
  onFolderDragOver: (folderPath: string) => void;
  onFolderDragLeave: () => void;
  onFolderDrop: (folderPath: string) => void;
}

export const FolderTreeNode = memo(function FolderTreeNode({
  node, activeNoteId, collapsed, depth = 0,
  onToggle, onNoteClick, onNotePin, onNoteDelete,
  onNoteArchive, onNoteMove, onNoteMoveToFolder, onNoteReveal, onCreateInFolder,
  dropTarget, onNoteDragStart, onNoteDragEnd,
  onFolderDragStart, onFolderDragEndSource,
  onFolderDragOver, onFolderDragLeave, onFolderDrop,
}: FolderTreeNodeProps) {
  // The collapsed map is keyed by LOWERCASED folder path (persisted state uses
  // case-insensitive keys, matching buildFolderTree's case-insensitive dedupe).
  const isCollapsed = collapsed[node.path.toLowerCase()];
  const indent = depth * 10;
  const isDragOver = dropTarget === node.path;

  return (
    <div>
      <div
        className={cn(
          "group flex items-center gap-1 px-2 py-1.5 cursor-pointer transition-colors",
          isDragOver
            ? "bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] outline outline-1 outline-[var(--accent)] outline-offset-[-1px] rounded"
            : "hover:bg-[var(--surface-2)]",
        )}
        style={{ paddingLeft: `${8 + indent}px` }}
        onClick={() => onToggle(node.path)}
        draggable
        onDragStart={(e) => { e.stopPropagation(); onFolderDragStart(node.path); }}
        onDragEnd={(e) => { e.stopPropagation(); onFolderDragEndSource(); }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); onFolderDragOver(node.path); }}
        onDragLeave={(e) => { e.stopPropagation(); onFolderDragLeave(); }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onFolderDrop(node.path); }}
      >
        {isCollapsed
          ? <ChevronRight size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
          : <ChevronDown size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />}
        {isCollapsed
          ? <Folder size={12} className="text-[var(--text-tertiary)] flex-shrink-0" />
          : <FolderOpen size={12} className="text-[var(--accent)] flex-shrink-0" />}
        <Tooltip content={node.name}>
          <span className="text-[0.786rem] font-medium text-[var(--text-secondary)] flex-1 truncate">{node.name}</span>
        </Tooltip>
        <button
          onClick={(e) => { e.stopPropagation(); onCreateInFolder(node.path); }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--accent)] hover:bg-[var(--accent-dim)] transition-all"
          title={`New note in ${node.name}`}
        >
          <Plus size={10} />
        </button>
      </div>

      {!isCollapsed && (
        <div>
          {node.children.map((child) => (
            <FolderTreeNode
              key={child.path}
              node={child}
              activeNoteId={activeNoteId}
              collapsed={collapsed}
              depth={depth + 1}
              onToggle={onToggle}
              onNoteClick={onNoteClick}
              onNotePin={onNotePin}
              onNoteDelete={onNoteDelete}
              onNoteArchive={onNoteArchive}
              onNoteMove={onNoteMove}
              onNoteMoveToFolder={onNoteMoveToFolder}
              onNoteReveal={onNoteReveal}
              onCreateInFolder={onCreateInFolder}
              dropTarget={dropTarget}
              onNoteDragStart={onNoteDragStart}
              onNoteDragEnd={onNoteDragEnd}
              onFolderDragStart={onFolderDragStart}
              onFolderDragEndSource={onFolderDragEndSource}
              onFolderDragOver={onFolderDragOver}
              onFolderDragLeave={onFolderDragLeave}
              onFolderDrop={onFolderDrop}
            />
          ))}
          {node.notes.map((note) => (
            <NoteListItem
              key={note.id}
              note={note}
              isActive={note.id === activeNoteId}
              indent={indent + 16}
              onClick={() => onNoteClick(note.id)}
              onPin={() => onNotePin(note)}
              onDelete={() => onNoteDelete(note)}
              onArchive={() => onNoteArchive(note)}
              onMove={() => onNoteMove(note)}
              onMoveToFolder={() => onNoteMoveToFolder(note)}
              onReveal={() => onNoteReveal(note)}
              onDragStart={onNoteDragStart}
              onDragEnd={onNoteDragEnd}
            />
          ))}
          {node.notes.length === 0 && node.children.length === 0 && (
            <button
              onClick={() => onCreateInFolder(node.path)}
              className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--accent)] hover:bg-[var(--surface-2)] transition-colors"
              style={{ paddingLeft: `${indent + 24}px` }}
            >
              <Plus size={10} />
              New note
            </button>
          )}
        </div>
      )}
    </div>
  );
});
