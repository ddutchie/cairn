"use client";

import { useState, useRef, useEffect } from "react";
import { useCairnStore } from "@/store";
import { WORKSPACE_ICONS, DEFAULT_WORKSPACE_ICON, WorkspaceIcon } from "@/lib/workspace-icons";

interface Props {
  onComplete: () => void;
}

export function CreateWorkspace({ onComplete }: Props) {
  const { createWorkspace, setActiveProject } = useCairnStore();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState(DEFAULT_WORKSPACE_ICON);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    try {
      await createWorkspace(trimmed, icon);
      onComplete();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col items-center justify-center h-full w-full bg-[var(--background)] px-6">
      {/* Logotype */}
      <div className="mb-10 text-center select-none">
        <h1
          className="text-4xl font-semibold text-[var(--text-primary)] tracking-tight mb-1"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Cairn
        </h1>
        <p className="text-sm text-[var(--text-tertiary)]">Your personal knowledge base</p>
      </div>

      {/* Card */}
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 flex flex-col gap-5"
      >
        <div>
          <h2 className="text-sm font-medium text-[var(--text-primary)] mb-1">
            Name your workspace
          </h2>
          <p className="text-xs text-[var(--text-tertiary)]">
            This is where all your projects and notes live.
          </p>
        </div>

        {/* Icon picker */}
        <div className="flex flex-wrap gap-2">
          {WORKSPACE_ICONS.map(({ name: iconName }) => (
            <button
              key={iconName}
              type="button"
              onClick={() => setIcon(iconName)}
              className={[
                "w-8 h-8 rounded-lg flex items-center justify-center transition-colors text-[var(--text-secondary)]",
                icon === iconName
                  ? "bg-[var(--accent-dim)] ring-1 ring-[var(--accent)] text-[var(--accent)]"
                  : "bg-[var(--surface-2)] hover:bg-[var(--surface-3)]",
              ].join(" ")}
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
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Personal, Work, Research…"
            className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
            maxLength={48}
          />
        </div>

        {/* Submit */}
        <button
          type="submit"
          disabled={!name.trim() || submitting}
          className={[
            "w-full py-2 rounded-lg text-sm font-medium transition-all",
            name.trim() && !submitting
              ? "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]"
              : "bg-[var(--surface-2)] text-[var(--text-tertiary)] cursor-not-allowed",
          ].join(" ")}
        >
          {submitting ? "Creating…" : "Create workspace"}
        </button>
      </form>
    </div>
  );
}
