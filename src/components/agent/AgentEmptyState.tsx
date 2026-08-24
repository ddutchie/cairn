"use client";

import { Plus, Bot } from "lucide-react";
import { useAgentSessionActions } from "./useAgentSessionActions";

export function AgentEmptyState() {
  const { handleNewSession, project } = useAgentSessionActions();

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

    </div>
  );
}
