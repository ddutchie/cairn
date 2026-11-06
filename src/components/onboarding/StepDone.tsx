"use client";

import React, { useState } from "react";
import { Check } from "lucide-react";
import { Shell, NavRow } from "./shared";

interface Props {
  /** Omitted when there is nothing safe to go back to. */
  onBack?: () => void;
  onComplete: (startTour: boolean) => void;
  /** False when the user skipped project creation. The demo needs project
   *  content (board, notes, sidebar), so it is not offered without one. */
  hasProject: boolean;
}

/** Last step of the first run: confirm setup and choose whether to start the demo. */
export function StepDone({ onBack, onComplete, hasProject }: Props) {
  const [startDemo, setStartDemo] = useState(true);
  const demoOn = hasProject && startDemo;

  return (
    <Shell step="done">
      <div className="w-full max-w-md flex flex-col gap-5">
        <div className="text-center">
          <p className="text-base font-semibold text-[var(--text-primary)] mb-1">Ready to start.</p>
          <p className="text-xs text-[var(--text-tertiary)]">
            {hasProject ? "Your workspace is set up." : "Your workspace is set up. Add a project whenever you like."}
          </p>
        </div>

        {/* Demo toggle (the tour needs a project to point at) */}
        <div className="flex items-start justify-between gap-4 px-4 py-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]">
          <div className="flex flex-col gap-0.5 min-w-0">
            <p className="text-xs font-medium text-[var(--text-primary)]">Start the demo</p>
            <p className="text-2xs text-[var(--text-tertiary)] leading-relaxed">
              {hasProject
                ? "A step-by-step walkthrough of the sidebar, board, notes, Idea Flow, chat and agent."
                : "Needs a project. Create one to take the walkthrough."}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={demoOn}
            aria-label="Start the demo"
            disabled={!hasProject}
            onClick={() => setStartDemo((v) => !v)}
            className={demoOn
              ? "relative mt-0.5 h-5 w-9 shrink-0 rounded-full bg-[var(--accent)] transition-colors disabled:opacity-40"
              : "relative mt-0.5 h-5 w-9 shrink-0 rounded-full bg-[var(--border)] transition-colors disabled:opacity-40"}
          >
            <span
              className={demoOn
                ? "absolute top-0.5 left-[18px] h-4 w-4 rounded-full bg-[var(--surface)] transition-all"
                : "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-[var(--surface)] transition-all"}
            />
          </button>
        </div>


        <NavRow
          onBack={onBack}
          onNext={() => onComplete(demoOn)}
          nextLabel="Open Cairn"
          nextIcon={<Check size={13} />}
        />
      </div>
    </Shell>
  );
}
