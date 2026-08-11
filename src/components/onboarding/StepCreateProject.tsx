"use client";

import { useRef, useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { MicroLabel } from "@/components/ui/labels";
import { WORKSPACE_ICONS, ProjectIcon } from "@/lib/workspace-icons";
import { Shell } from "./shared";

interface Props {
  name: string;
  icon: string;
  submitting: boolean;
  onBack: () => void;
  onNameChange: (v: string) => void;
  onIconChange: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onSkip: () => void;
}

export function StepCreateProject({
  name,
  icon,
  submitting,
  onBack,
  onNameChange,
  onIconChange,
  onSubmit,
  onSkip,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <Shell step="create-project">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 flex flex-col gap-5"
      >
        <div>
          <div className="flex items-center gap-2 mb-1">
            <button
              type="button"
              onClick={onBack}
              disabled={submitting}
              aria-label="Go back to previous step"
              className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-[var(--text-tertiary)]"
            >
              <ArrowLeft size={13} />
            </button>
            <h2 className="text-sm font-medium text-[var(--text-primary)]">Create your first project</h2>
          </div>
          <p className="text-xs text-[var(--text-tertiary)]">
            Projects hold your notes, tasks, and ideas. You can add more later.
          </p>
        </div>

        {/* Icon picker */}
        <div className="flex flex-wrap gap-2">
          {WORKSPACE_ICONS.map(({ name: iconName }) => (
            <button
              key={iconName}
              type="button"
              onClick={() => onIconChange(iconName)}
              disabled={submitting}
              aria-label={`Use ${iconName} icon`}
              aria-pressed={icon === iconName}
              className={cn(
                "w-8 h-8 rounded-lg flex items-center justify-center transition-colors text-[var(--text-secondary)] disabled:opacity-50 disabled:cursor-not-allowed",
                icon === iconName
                  ? "bg-[var(--accent-dim)] ring-1 ring-[var(--accent)] text-[var(--accent)]"
                  : "bg-[var(--surface-2)] hover:bg-[var(--surface-3)]"
              )}
            >
              <ProjectIcon name={iconName} size={14} />
            </button>
          ))}
        </div>

        {/* Name input */}
        <div className="flex items-center gap-2 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 focus-within:ring-1 focus-within:ring-[var(--accent)]">
          <span className="select-none text-[var(--text-tertiary)]">
            <ProjectIcon name={icon} size={14} />
          </span>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="e.g. My First Project, Research, Personal…"
            className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
            maxLength={48}
          />
        </div>

        <button
          type="submit"
          disabled={!name.trim() || submitting}
          className={cn(
            "w-full py-2 rounded-lg text-sm font-medium transition-all",
            name.trim() && !submitting
              ? "bg-[var(--accent)] text-[var(--accent-fg,#fff)] hover:bg-[var(--accent-hover)]"
              : "bg-[var(--surface-2)] text-[var(--text-tertiary)] cursor-not-allowed"
          )}
        >
          {submitting ? "Creating…" : "Create project"}
        </button>

        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-[var(--border)]" />
          <MicroLabel>or</MicroLabel>
          <div className="flex-1 h-px bg-[var(--border)]" />
        </div>

        <button
          type="button"
          onClick={onSkip}
          disabled={submitting}
          className="w-full py-2 rounded-lg text-sm font-medium text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-[var(--text-tertiary)]"
        >
          Skip — I&apos;ll create one later
        </button>
      </form>
    </Shell>
  );
}
