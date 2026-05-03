"use client";

import React from "react";
import { ChevronLeft } from "lucide-react";
import { WorkspaceIcon } from "@/lib/workspace-icons";
import { Tooltip } from "@/components/ui/tooltip";
import type { Workspace } from "@/types";

interface WorkspaceSwitcherProps {
  workspace: Workspace | undefined;
  onCollapse: () => void;
}

export function WorkspaceSwitcher({ workspace, onCollapse }: WorkspaceSwitcherProps) {
  return (
    <div className="flex items-center gap-2 px-3 h-11 border-b border-[var(--border)] flex-shrink-0">
      <WorkspaceIcon name={workspace?.icon} size={15} className="text-[var(--text-secondary)] flex-shrink-0" />
      <span className="text-sm font-semibold text-[var(--text-primary)] truncate flex-1">
        {workspace?.name ?? "Workspace"}
      </span>
      <Tooltip content="Collapse sidebar" side="right">
        <button onClick={onCollapse}
          className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors">
          <ChevronLeft size={13} />
        </button>
      </Tooltip>
    </div>
  );
}
