"use client";

import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown, History, Code2, Trash2 } from "lucide-react";
import { useCairnStore } from "@/store";
import { cn, formatDateCompact } from "@/lib/utils";
import { useAgentSessionActions } from "./useAgentSessionActions";
import type { CodingSessionSummary } from "@/types";

interface AgentSessionTabProps {
  isActive: boolean;
  onActivate: () => void;
}

export function AgentSessionTab({ isActive, onActivate }: AgentSessionTabProps) {
  const {
    codingSessionHistory,
    activeCodingSessionId,
    fetchCodingSessionHistory,
    deleteCodingSessionFromHistory,
    activeProjectId,
  } = useCairnStore(useShallow((s) => ({
    codingSessionHistory: s.codingSessionHistory,
    activeCodingSessionId: s.activeCodingSessionId,
    fetchCodingSessionHistory: s.fetchCodingSessionHistory,
    deleteCodingSessionFromHistory: s.deleteCodingSessionFromHistory,
    activeProjectId: s.activeProjectId,
  })));

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { handleResumeSession: _handleResumeSession } = useAgentSessionActions();

  useEffect(() => {
    if (!dropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [dropdownOpen]);

  useEffect(() => {
    if (dropdownOpen && activeProjectId) {
      fetchCodingSessionHistory(activeProjectId);
    }
  }, [dropdownOpen, activeProjectId, fetchCodingSessionHistory]);

  async function handleResumeSession(summary: CodingSessionSummary) {
    setDropdownOpen(false);
    if (summary.id === activeCodingSessionId) return;
    await _handleResumeSession(summary);
  }

  async function handleDeleteSession(e: React.MouseEvent, sessionId: string) {
    e.stopPropagation();
    await deleteCodingSessionFromHistory(sessionId);
  }

  return (
    <div className="relative flex-shrink-0 h-full flex items-center border-r border-[var(--border)]" ref={dropdownRef}>
      <button
        onClick={onActivate}
        role="tab"
        aria-selected={isActive}
        className={cn(
          "flex items-center gap-1.5 px-3 h-full text-xs font-semibold whitespace-nowrap transition-colors flex-shrink-0",
          isActive
            ? "text-[var(--text-primary)] bg-[var(--background)]"
            : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
        )}
      >
        <Code2 size={11} className={cn("flex-shrink-0", isActive ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]")} />
        <span className="max-w-[100px] truncate">Cairn Agent</span>
      </button>
      <button
        aria-label="Session history"
        onClick={() => setDropdownOpen((v) => !v)}
        className={cn(
          "flex items-center justify-center h-full px-1.5 text-xs transition-colors hover:bg-[var(--surface-2)] border-l border-[var(--border)]",
          dropdownOpen ? "text-[var(--text-primary)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
        )}
      >
        <ChevronDown size={10} />
      </button>

      {dropdownOpen && (
        <div className="absolute left-0 top-full z-50 mt-0.5 w-64 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl overflow-hidden">
          <div className="px-3 py-2 border-b border-[var(--border)]">
            <div className="flex items-center gap-1.5">
              <History size={10} className="text-[var(--text-tertiary)]" />
              <span className="text-[0.643rem] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Session history</span>
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {codingSessionHistory.length === 0 ? (
              <p className="px-3 py-3 text-[0.714rem] text-[var(--text-tertiary)] text-center">No saved sessions</p>
            ) : (
              codingSessionHistory.map((summary) => (
                <div
                  key={summary.id}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--surface-2)] transition-colors group",
                    summary.id === activeCodingSessionId && "bg-[var(--surface-2)]"
                  )}
                >
                  <button
                    onClick={() => handleResumeSession(summary)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <p className="text-[0.714rem] text-[var(--text-primary)] truncate">{summary.taskTitle}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={cn(
                        "text-[0.607rem] font-medium px-1 py-0 rounded",
                        summary.mode === "plan"
                          ? "bg-[color-mix(in_srgb,var(--warning,#f59e0b)_15%,transparent)] text-[var(--warning,#f59e0b)]"
                          : "bg-[var(--accent-dim)] text-[var(--accent)]"
                      )}>
                        {summary.mode.toUpperCase()}
                      </span>
                      <span className="text-[0.607rem] text-[var(--text-tertiary)]">{formatDateCompact(summary.updatedAt)}</span>
                      {summary.status === "exited" && (
                        <span className="text-[0.607rem] text-[var(--text-tertiary)]">· exited</span>
                      )}
                    </div>
                  </button>
                  <button
                    aria-label="Delete session"
                    onClick={(e) => handleDeleteSession(e, summary.id)}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] transition-all flex-shrink-0"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
