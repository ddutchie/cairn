"use client";

import React, { useState } from "react";
import { FileText, Kanban, Workflow, MessageSquare, Check, HelpCircle } from "lucide-react";
import { Shell, NavRow } from "./shared";

interface Props {
  onBack: () => void;
  onComplete: (startTour: boolean) => void;
}

const FEATURE_CARDS = [
  {
    icon: <FileText size={18} className="text-[var(--accent)]" />,
    label: "Notes",
    desc: "Markdown files you own. Formatting toolbar, read mode, AI text actions.",
    shortcut: "⌘2",
  },
  {
    icon: <Kanban size={18} className="text-[var(--accent)]" />,
    label: "Board",
    desc: "Kanban with priority, due dates, WIP limits, and drag-and-drop.",
    shortcut: "⌘3",
  },
  {
    icon: <MessageSquare size={18} className="text-[var(--accent)]" />,
    label: "AI Chat",
    desc: "Chat with your project. Creates tasks, edits notes, generates PRDs.",
    shortcut: "⌘/",
  },
  {
    icon: <Workflow size={18} className="text-[var(--accent)]" />,
    label: "Idea Flow",
    desc: "Freeform canvas. Connect ideas to notes and tasks before you build.",
    shortcut: "⌘4",
  },
];

export function StepDone({ onBack, onComplete }: Props) {
  const [startTour, setStartTour] = useState(true);

  return (
    <Shell step="done">
      <div className="w-full max-w-md flex flex-col gap-5">
        <div className="text-center">
          <p className="text-base font-semibold text-[var(--text-primary)] mb-1">You&apos;re all set.</p>
          <p className="text-xs text-[var(--text-tertiary)]">Here&apos;s what&apos;s waiting for you.</p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {FEATURE_CARDS.map((f) => (
            <div
              key={f.label}
              className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 flex flex-col gap-2 hover:border-[var(--accent)]/40 transition-colors"
            >
              <div className="flex items-center justify-between">
                {f.icon}
                <kbd className="text-[0.6rem] px-1.5 py-0.5 rounded bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-tertiary)] font-mono">
                  {f.shortcut}
                </kbd>
              </div>
              <p className="text-xs font-semibold text-[var(--text-primary)]">{f.label}</p>
              <p className="text-[0.7rem] text-[var(--text-tertiary)] leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>

        {/* Start quick app tour checkbox */}
        <label className="flex items-center gap-2.5 px-4 py-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] cursor-pointer hover:border-[var(--accent)]/30 transition-all select-none">
          <input
            type="checkbox"
            checked={startTour}
            onChange={(e) => setStartTour(e.target.checked)}
            className="w-4 h-4 rounded border-[var(--border)] text-[var(--accent)] focus:ring-[var(--accent)] bg-[var(--surface)] cursor-pointer"
          />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-[var(--text-primary)] flex items-center gap-1.5">
              <HelpCircle size={13} className="text-[var(--accent)]" />
              Start a quick interactive app tour on launch
            </p>
            <p className="text-[0.65rem] text-[var(--text-tertiary)] mt-0.5">Recommended for new users to learn the workspace</p>
          </div>
        </label>

        <NavRow
          onBack={onBack}
          onNext={() => onComplete(startTour)}
          nextLabel="Open Cairn"
          nextIcon={<Check size={13} />}
        />
      </div>
    </Shell>
  );
}
