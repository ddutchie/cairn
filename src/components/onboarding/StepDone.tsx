"use client";

import { FileText, Kanban, Workflow, MessageSquare, Check } from "lucide-react";
import { Shell, NavRow } from "./shared";

interface Props {
  onBack: () => void;
  onComplete: () => void;
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
  return (
    <Shell step="done">
      <div className="w-full max-w-md flex flex-col gap-5">
        <div className="text-center">
          <p className="text-base font-semibold text-[var(--text-primary)] mb-1">You're all set.</p>
          <p className="text-xs text-[var(--text-tertiary)]">Here's what's waiting for you.</p>
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

        <NavRow
          onBack={onBack}
          onNext={onComplete}
          nextLabel="Open Cairn"
          nextIcon={<Check size={13} />}
        />
      </div>
    </Shell>
  );
}
