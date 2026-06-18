"use client";

import { useShallow } from "zustand/react/shallow";
import { Plus, Bot, History, ArrowRight } from "lucide-react";
import { useCairnStore } from "@/store";
import { cn } from "@/lib/utils";
import { useAgentSessionActions } from "./useAgentSessionActions";
import { formatDate } from "./sessionUtils";

export function AgentEmptyState() {
  const { piSessionHistory, persistentPiSessionId } = useCairnStore(useShallow((s) => ({
    piSessionHistory: s.piSessionHistory,
    persistentPiSessionId: s.persistentPiSessionId,
  })));

  const { handleNewSession, handleResumeSession, project } = useAgentSessionActions();
  const recentSessions = piSessionHistory.slice(0, 5);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-6 text-center">
      <div className="w-10 h-10 rounded-full bg-[var(--accent-dim)] border border-[color-mix(in_srgb,var(--accent)_20%,transparent)] flex items-center justify-center">
        <Bot size={18} className="text-[var(--accent)]" />
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-[0.786rem] font-semibold text-[var(--text-primary)]">Cairn Agent</p>
        <p className="text-[0.714rem] text-[var(--text-tertiary)] max-w-44">
          {project?.codeDirectory
            ? "Start a new session or resume a previous one."
            : "Set a code directory on this project to start a session."}
        </p>
      </div>

      <button
        onClick={handleNewSession}
        disabled={!project?.codeDirectory}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--accent)] text-[var(--background)] text-[0.714rem] font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Plus size={11} />
        New session
      </button>

      {recentSessions.length > 0 && (
        <div className="w-full max-w-56 flex flex-col gap-0.5 mt-1">
          <div className="flex items-center gap-1.5 mb-1">
            <History size={10} className="text-[var(--text-tertiary)]" />
            <span className="text-[0.643rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wider">Recent</span>
          </div>
          {recentSessions.map((summary) => (
            <button
              key={summary.id}
              onClick={() => handleResumeSession(summary)}
              className={cn(
                "group w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors",
                "hover:bg-[var(--surface-2)] border border-transparent hover:border-[var(--border)]",
                summary.id === persistentPiSessionId && "bg-[var(--surface-2)] border-[var(--border)]",
              )}
            >
              <div className="flex-1 min-w-0">
                <p className="text-[0.714rem] text-[var(--text-secondary)] truncate">{summary.taskTitle}</p>
                <p className="text-[0.607rem] text-[var(--text-tertiary)]">{formatDate(summary.updatedAt)}</p>
              </div>
              <ArrowRight size={10} className="text-[var(--text-tertiary)] shrink-0 opacity-0 group-hover:opacity-100" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
