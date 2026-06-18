"use client";

import React, { useState, useEffect, useRef } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import type { FolderNode } from "./buildFolderTree";

interface FolderPickerDialogProps {
  folderTree: FolderNode[];
  mode: "move" | "create";
  currentFolder?: string;
  onSelect: (folder: string) => void;
  onClose: () => void;
}

export function FolderPickerDialog({ folderTree, mode, currentFolder = "", onSelect, onClose }: FolderPickerDialogProps) {
  const [addingUnder, setAddingUnder] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const newInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (addingUnder !== null) newInputRef.current?.focus();
  }, [addingUnder]);

  function handleCreate() {
    const name = newFolderName.trim();
    if (!name) return;
    const full = addingUnder ? `${addingUnder}/${name}` : name;
    onSelect(full);
  }

  function openAdd(parentPath: string, e: React.MouseEvent) {
    e.stopPropagation();
    setAddingUnder(parentPath);
    setNewFolderName("");
  }

  function cancelAdd() {
    setAddingUnder(null);
    setNewFolderName("");
  }

  const inlineInput = (
    <div className="flex items-center gap-2 px-3 py-2 border-t border-[var(--border)] bg-[var(--surface-2)]">
      <FolderPlus size={12} className="text-[var(--accent)] shrink-0" />
      <input
        ref={newInputRef}
        value={newFolderName}
        onChange={(e) => setNewFolderName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleCreate();
          if (e.key === "Escape") cancelAdd();
        }}
        placeholder="Folder name…"
        className="flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
      />
      <button
        onClick={handleCreate}
        disabled={!newFolderName.trim()}
        className="text-[0.714rem] text-[var(--accent)] disabled:opacity-30 hover:underline shrink-0"
      >
        Create & move
      </button>
      <button onClick={cancelAdd} className="text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">
        ✕
      </button>
    </div>
  );

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New folder" : "Move to folder"}</DialogTitle>
        </DialogHeader>
        <div className="px-5 pb-5 pt-1">
          <div className="rounded-lg border border-[var(--border)] overflow-hidden mb-3">
            <div className={cn(
              "group flex items-center gap-2 px-3 py-2 text-xs transition-colors border-b border-[var(--border)]",
              currentFolder === "" && mode === "move" ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
            )}>
              <button
                className="flex items-center gap-2 flex-1 min-w-0 text-left"
                onClick={() => mode === "move" ? onSelect("") : openAdd("", { stopPropagation: () => {} } as React.MouseEvent)}
              >
                <Folder size={12} className="shrink-0" />
                <span className="font-medium">Root</span>
              </button>
              <button
                onClick={(e) => openAdd("", e)}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-all"
                title="New folder in root"
              >
                <FolderPlus size={11} />
              </button>
            </div>

            {addingUnder === "" && inlineInput}

            {folderTree.length === 0 && addingUnder === null && (
              <p className="px-3 py-3 text-[0.714rem] text-[var(--text-tertiary)]">No folders yet</p>
            )}

            {folderTree.map((node) => (
              <FolderPickerNode
                key={node.path}
                node={node}
                currentFolder={currentFolder}
                depth={0}
                mode={mode}
                addingUnder={addingUnder}
                newFolderName={newFolderName}
                newInputRef={newInputRef}
                onSelect={onSelect}
                onOpenAdd={openAdd}
                onNameChange={setNewFolderName}
                onCreate={handleCreate}
                onCancel={cancelAdd}
                inlineInput={inlineInput}
              />
            ))}
          </div>

          <div className="flex justify-end">
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Cancel</Button>
            </DialogClose>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface FolderPickerNodeProps {
  node: FolderNode;
  currentFolder: string;
  depth: number;
  mode: "move" | "create";
  addingUnder: string | null;
  newFolderName: string;
  newInputRef: React.RefObject<HTMLInputElement | null>;
  onSelect: (folder: string) => void;
  onOpenAdd: (parentPath: string, e: React.MouseEvent) => void;
  onNameChange: (v: string) => void;
  onCreate: () => void;
  onCancel: () => void;
  inlineInput: React.ReactNode;
}

function FolderPickerNode({
  node, currentFolder, depth, mode, addingUnder, onSelect, onOpenAdd, inlineInput,
}: FolderPickerNodeProps) {
  const [open, setOpen] = useState(true);
  const isSelected = mode === "move" && currentFolder === node.path;
  const indent = depth * 12;

  return (
    <div className="border-t border-[var(--border)]">
      <div
        className={cn(
          "group flex items-center gap-2 text-xs transition-colors",
          isSelected
            ? "bg-[var(--accent-dim)] text-[var(--accent)]"
            : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
        )}
        style={{ paddingLeft: `${12 + indent}px`, paddingRight: "12px", paddingTop: "7px", paddingBottom: "7px" }}
      >
        {node.children.length > 0 ? (
          <button
            onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
            className="shrink-0 text-[var(--text-tertiary)]"
          >
            {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </button>
        ) : (
          <span className="w-[10px] shrink-0" />
        )}
        <button
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
          onClick={(e) => mode === "move" ? onSelect(node.path) : onOpenAdd(node.path, e)}
        >
          {open && node.children.length > 0
            ? <FolderOpen size={12} className="shrink-0" />
            : <Folder size={12} className="shrink-0" />}
          <span className="truncate">{node.name}</span>
        </button>
        <button
          onClick={(e) => onOpenAdd(node.path, e)}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-all shrink-0"
          title={`New folder in ${node.name}`}
        >
          <FolderPlus size={11} />
        </button>
      </div>

      {addingUnder === node.path && inlineInput}

      {open && node.children.map((child) => (
        <FolderPickerNode
          key={child.path}
          node={child}
          currentFolder={currentFolder}
          depth={depth + 1}
          mode={mode}
          addingUnder={addingUnder}
          newFolderName=""
          newInputRef={{ current: null }}
          onSelect={onSelect}
          onOpenAdd={onOpenAdd}
          onNameChange={() => {}}
          onCreate={() => {}}
          onCancel={() => {}}
          inlineInput={inlineInput}
        />
      ))}
    </div>
  );
}
