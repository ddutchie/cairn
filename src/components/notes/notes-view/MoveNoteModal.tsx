"use client";

import React from "react";
import { FolderInput, X } from "lucide-react";
import type { Project } from "@/types";

interface MoveNoteModalProps {
  workspaceProjects: Project[];
  activeProjectId: string | null;
  onMove: (projectId: string) => void;
  onClose: () => void;
}

export function MoveNoteModal({ workspaceProjects, activeProjectId, onMove, onClose }: MoveNoteModalProps) {
  const targets = workspaceProjects.filter((p) => p.id !== activeProjectId);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl w-72 p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderInput size={14} className="text-[var(--accent)]" />
            <span className="text-sm font-semibold text-[var(--text-primary)]">Move to project</span>
          </div>
          <button onClick={onClose} className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]">
            <X size={13} />
          </button>
        </div>
        <div className="space-y-1">
          {targets.map((p) => (
            <button key={p.id} onClick={() => onMove(p.id)}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-2">
              <FolderInput size={12} className="text-[var(--text-tertiary)]" />
              {p.name}
            </button>
          ))}
          {targets.length === 0 && (
            <p className="text-xs text-[var(--text-tertiary)] text-center py-3">No other projects</p>
          )}
        </div>
      </div>
    </div>
  );
}
