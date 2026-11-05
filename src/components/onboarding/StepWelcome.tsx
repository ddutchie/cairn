"use client";

import React from "react";
import { FileText, Kanban, Workflow, MessageSquare, ShieldCheck } from "lucide-react";
import { Shell, NavRow } from "./shared";

interface Props {
  onNext: () => void;
}

const POINTS = [
  {
    icon: <FileText size={16} className="text-[var(--accent)]" />,
    title: "Notes you own",
    body: "Markdown files saved on your disk. Open them in any other app.",
  },
  {
    icon: <Kanban size={16} className="text-[var(--accent)]" />,
    title: "A board for each project",
    body: "Plan tasks, set priorities and drag them through your columns.",
  },
  {
    icon: <Workflow size={16} className="text-[var(--accent)]" />,
    title: "Idea Flow",
    body: "A freeform canvas to connect ideas to notes and tasks before you build.",
  },
  {
    icon: <MessageSquare size={16} className="text-[var(--accent)]" />,
    title: "AI that works on your workspace",
    body: "Chat with a provider you choose, or a local model. It can read and edit your notes and tasks.",
  },
];

/** First screen of the first run: what Cairn is, before any setup. */
export function StepWelcome({ onNext }: Props) {
  return (
    <Shell step="welcome">
      <div className="w-full max-w-md flex flex-col gap-5">
        <p className="text-center text-base font-semibold text-[var(--text-primary)]">Welcome to Cairn.</p>

        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-[var(--text-secondary)]">What it is</p>
          {POINTS.map((p) => (
            <div key={p.title} className="flex gap-3 bg-[var(--surface)] border border-[var(--border)] rounded-xl p-3">
              <div className="mt-0.5 shrink-0">{p.icon}</div>
              <div className="flex flex-col gap-0.5">
                <p className="text-xs font-semibold text-[var(--text-primary)]">{p.title}</p>
                <p className="text-xs text-[var(--text-tertiary)] leading-relaxed">{p.body}</p>
              </div>
            </div>
          ))}
        </div>

        <p className="flex items-start gap-2 text-2xs text-[var(--text-tertiary)] leading-relaxed">
          <ShieldCheck size={12} className="mt-0.5 shrink-0 text-[var(--accent)]" />
          Your data stays on this computer. It only leaves if you connect an AI provider or turn on sync.
        </p>

        <NavRow onNext={onNext} nextLabel="Get started" />
      </div>
    </Shell>
  );
}
