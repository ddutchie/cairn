"use client";

import { useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { IconButton } from "@/components/ui/icon-button";
import { MicroLabel } from "@/components/ui/labels";
import { WORKSPACE_ICONS, ProjectIcon } from "@/lib/workspace-icons";
import { Shell } from "./shared";

interface Props {
  name: string;
  icon: string;
  submitting: boolean;
  onNameChange: (v: string) => void;
  onIconChange: (v: string) => void;
  /** Shown under the form when creating the project fails. */
  error?: string | null;
  onSubmit: (e: React.FormEvent) => void;
  /** Creates the starter project (welcome note and sample cards). */
  onSample: () => void;
}

export function StepCreateProject({
  name,
  icon,
  submitting,
  onNameChange,
  onIconChange,
  error = null,
  onSubmit,
  onSample,
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
            <h2 className="text-sm font-medium text-[var(--text-primary)]">Create your first project</h2>
          </div>
          <p className="text-xs text-[var(--text-tertiary)]">
            Projects hold your notes, tasks, and ideas. You can add more later.
          </p>
        </div>

        {/* Icon picker */}
        <div className="flex flex-wrap gap-2">
          {WORKSPACE_ICONS.map(({ name: iconName }) => (
            <IconButton
              label={`Use ${iconName} icon`}
              key={iconName}
              onClick={() => onIconChange(iconName)}
              disabled={submitting}
              aria-pressed={icon === iconName}
              className={cn("w-8 h-8 text-[var(--text-secondary)] disabled:opacity-50 disabled:cursor-not-allowed", icon === iconName
                  ? "bg-[var(--accent-dim)] ring-1 ring-[var(--accent)] text-[var(--accent)]"
                  : "bg-[var(--surface-2)] hover:bg-[var(--surface-3)]")}
            >
              <ProjectIcon name={iconName} size={14} />
            </IconButton>
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

        {error && (
          <p className="text-xs text-[var(--danger)] leading-snug" role="alert">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-[var(--border)]" />
          <MicroLabel>or</MicroLabel>
          <div className="flex-1 h-px bg-[var(--border)]" />
        </div>

        <button
          type="button"
          onClick={onSample}
          disabled={submitting}
          className="w-full py-2 rounded-lg text-sm font-medium text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-[var(--text-tertiary)]"
        >
          Start with a sample project
        </button>
      </form>
    </Shell>
  );
}
