"use client";

import React from "react";
import { FolderInput, FolderOpen } from "lucide-react";
import type { Project } from "@/types";
import { ModalShell } from "@/components/ui/modal-shell";
import { ProjectIcon } from "@/lib/workspace-icons";

interface MoveNoteModalProps {
  workspaceProjects: Project[];
  activeProjectId: string | null;
  onMove: (projectId: string) => void;
  onClose: () => void;
}

export function MoveNoteModal({ workspaceProjects, activeProjectId, onMove, onClose }: MoveNoteModalProps) {
  const targets = workspaceProjects.filter((p) => p.id !== activeProjectId);
  return (
    <ModalShell
      onClose={onClose}
      size="sm"
      title={<><FolderInput size={14} className="text-[var(--accent)]" /> Move to project</>}
    >
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
              <ProjectIcon name={p.icon} size={14} className="text-[var(--text-tertiary)] shrink-0" />
              {p.name}
            </button>
          ))}
        </div>
      )}
    </ModalShell>
  );
}
