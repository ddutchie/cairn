"use client";

import React from "react";

const PROMPTS = [
  "Summarize this project",
  "What tasks are in progress?",
  "Create tasks from recent notes",
  "What are the blocked items?",
  "Draft a project brief",
];

interface SuggestedPromptsProps {
  onSend: (prompt: string) => void;
  disabled: boolean;
}

export function SuggestedPrompts({ onSend, disabled }: SuggestedPromptsProps) {
  return (
    <div className="space-y-4">
      <div className="text-center pt-4">
        <img src="/favicon.svg" alt="Cairn" className="w-10 h-10 mx-auto mb-3 opacity-80" />
        <p className="text-sm font-medium text-[var(--text-primary)]">Cairn AI</p>
        <p className="text-xs text-[var(--text-tertiary)] mt-1 max-w-52 mx-auto">
          Ask me about your project, notes, or tasks. I can read and write with your permission.
        </p>
      </div>
      <div className="space-y-1.5">
        {PROMPTS.map((prompt) => (
          <button key={prompt} onClick={() => onSend(prompt)} disabled={disabled}
            className="w-full text-left px-3 py-2.5 rounded-lg border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-all disabled:opacity-40 disabled:pointer-events-none">
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}
