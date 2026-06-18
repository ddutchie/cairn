"use client";

import { X, MessageSquare, CircleDot } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import type { TerminalSession } from "@/types";

interface TerminalTabProps {
  session: TerminalSession;
  isActive: boolean;
  onActivate: () => void;
  onClose: (e: React.MouseEvent) => void;
}

export function TerminalTab({ session, isActive, onActivate, onClose }: TerminalTabProps) {
  return (
    <div className="flex items-center h-full flex-shrink-0 group">
      <button
        onClick={onActivate}
        role="tab"
        aria-selected={isActive}
        className={cn(
          "flex items-center gap-1.5 px-3 h-full text-xs font-semibold whitespace-nowrap border-r border-[var(--border)] transition-colors flex-shrink-0",
          isActive
            ? "text-[var(--text-primary)] bg-[var(--background)]"
            : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
        )}
      >
        {session.sessionType === "pi" ? (
          <MessageSquare
            size={8}
            className={cn(
              "flex-shrink-0",
              session.status === "running" ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]"
            )}
          />
        ) : (
          <CircleDot
            size={8}
            className={cn(
              "flex-shrink-0",
              session.status === "running"
                ? "text-[var(--success)]"
                : "text-[var(--text-tertiary)]"
            )}
          />
        )}

        <span className="max-w-[120px] truncate">{session.taskTitle}</span>
        <span className="text-[var(--text-tertiary)]">{session.agentName}</span>

        {session.status === "exited" && (
          <span className="text-[0.65rem] text-[var(--text-tertiary)]">
            [{session.exitCode}]
          </span>
        )}
      </button>

      <Tooltip content="Close session" side="bottom">
        <button
          aria-label={`Close ${session.taskTitle}`}
          onClick={onClose}
          className="flex items-center justify-center h-full px-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors border-r border-[var(--border)]"
        >
          <X size={10} />
        </button>
      </Tooltip>
    </div>
  );
}
