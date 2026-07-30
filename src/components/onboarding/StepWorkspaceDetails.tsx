"use client";

import { useRef, useEffect } from "react";
import { ArrowLeft, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { WORKSPACE_ICONS, WorkspaceIcon } from "@/lib/workspace-icons";
import { Shell } from "./shared";

interface Props {
  chosenFolder: string | null;
  name: string;
  icon: string;
  submitting: boolean;
  showBack: boolean;
  /** True when the chosen folder contains a `.obsidian` directory. */
  isObsidianVault?: boolean;
  onBack: () => void;
  onNameChange: (v: string) => void;
  onIconChange: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

export function StepWorkspaceDetails({
  chosenFolder,
  name,
  icon,
  submitting,
  showBack,
  isObsidianVault = false,
  onBack,
  onNameChange,
  onIconChange,
  onSubmit,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <Shell step="workspace-details">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 flex flex-col gap-5"
      >
        <div>
          <div className="flex items-center gap-2 mb-1">
            {showBack && (
              <button
                type="button"
                onClick={onBack}
                className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
              >
                <ArrowLeft size={13} />
              </button>
            )}
            <h2 className="text-sm font-medium text-[var(--text-primary)]">Name your workspace</h2>
          </div>
          {chosenFolder && (
            <p className="text-xs text-[var(--text-tertiary)] font-mono truncate">{chosenFolder}</p>
          )}
        </div>

        {isObsidianVault && (
          <div className="flex items-start gap-2 bg-[var(--accent-dim)] border border-[color-mix(in_srgb,var(--accent)_35%,transparent)] rounded-lg px-3 py-2">
            <Sparkles size={14} className="text-[var(--accent)] shrink-0 mt-0.5" />
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              <span className="font-medium text-[var(--text-primary)]">Obsidian vault detected.</span>{" "}
              Your existing folders will become projects and your notes will be
              imported automatically — no need to set anything up.
            </p>
          </div>
        )}

        {/* Icon picker */}
        <div className="flex flex-wrap gap-2">
          {WORKSPACE_ICONS.map(({ name: iconName }) => (
            <button
              key={iconName}
              type="button"
              onClick={() => onIconChange(iconName)}
              className={cn(
                "w-8 h-8 rounded-lg flex items-center justify-center transition-colors text-[var(--text-secondary)]",
                icon === iconName
                  ? "bg-[var(--accent-dim)] ring-1 ring-[var(--accent)] text-[var(--accent)]"
                  : "bg-[var(--surface-2)] hover:bg-[var(--surface-3)]"
              )}
            >
              <WorkspaceIcon name={iconName} size={14} />
            </button>
          ))}
        </div>

        {/* Name input */}
        <div className="flex items-center gap-2 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 focus-within:ring-1 focus-within:ring-[var(--accent)]">
          <span className="select-none text-[var(--text-tertiary)]">
            <WorkspaceIcon name={icon} size={14} />
          </span>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="e.g. Personal, Work, Research…"
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
              ? "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]"
              : "bg-[var(--surface-2)] text-[var(--text-tertiary)] cursor-not-allowed"
          )}
        >
          {submitting ? "Creating…" : "Create workspace"}
        </button>
      </form>
    </Shell>
  );
}
