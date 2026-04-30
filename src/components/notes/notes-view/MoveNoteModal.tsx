"use client";

import React from "react";
import { FolderInput, FolderOpen } from "lucide-react";
import type { Project } from "@/types";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface MoveNoteModalProps {
  workspaceProjects: Project[];
  activeProjectId: string | null;
  onMove: (projectId: string) => void;
  onClose: () => void;
}

export function MoveNoteModal({ workspaceProjects, activeProjectId, onMove, onClose }: MoveNoteModalProps) {
  const targets = workspaceProjects.filter((p) => p.id !== activeProjectId);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderInput size={14} className="text-[var(--accent)]" />
            Move to project
          </DialogTitle>
        </DialogHeader>
        <div className="px-5 py-4">
          {targets.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <FolderOpen size={18} className="text-[var(--text-tertiary)] opacity-40" />
              <p className="text-xs text-[var(--text-tertiary)]">No other projects in this workspace</p>
            </div>
          ) : (
            <div className="space-y-1">
              {targets.map((p) => (
                <button
                  key={p.id}
                  onClick={() => { onMove(p.id); onClose(); }}
                  className="w-full text-left px-3 py-2 rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-2"
                >
                  <span className="text-base leading-none">{p.icon ?? "📁"}</span>
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
