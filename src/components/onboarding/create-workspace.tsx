"use client";

import { useState, useRef, useEffect } from "react";
import { useCairnStore } from "@/store";
import { WORKSPACE_ICONS, DEFAULT_WORKSPACE_ICON, WorkspaceIcon } from "@/lib/workspace-icons";
import { FolderOpen, ArrowLeft } from "lucide-react";

interface Props {
  onComplete: () => void;
  initialStep?: "choose-folder" | "workspace-details";
}

type Step = "choose-folder" | "workspace-details";

export function CreateWorkspace({ onComplete, initialStep = "choose-folder" }: Props) {
  const { createWorkspace } = useCairnStore();
  const [step, setStep] = useState<Step>(initialStep);
  const [chosenFolder, setChosenFolder] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState(DEFAULT_WORKSPACE_ICON);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // If landing directly on workspace-details (folder already configured),
    // pre-populate chosenFolder so the path display and submit work correctly.
    if (initialStep === "workspace-details" && typeof window !== "undefined" && window.electron) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window.electron as any).getWorkspacePath?.().then((p: string | null) => {
        if (p) setChosenFolder(p);
      });
    }
  }, [initialStep]);

  useEffect(() => {
    if (step === "workspace-details") {
      inputRef.current?.focus();
    }
  }, [step]);

  async function handleChooseFolder() {
    if (!window.electron) return;
    setSubmitting(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const folder = await (window.electron as any).selectWorkspaceFolder?.();
      if (!folder) return;
      setChosenFolder(folder);
      setStep("workspace-details");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCreateWorkspace(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    try {
      // If the folder was just chosen in this session, write the config now.
      // If initialStep was "workspace-details", config is already written.
      if (window.electron && chosenFolder && initialStep === "choose-folder") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (window.electron as any).initWorkspace?.(chosenFolder);
      }
      await createWorkspace(trimmed, icon);
      onComplete();
    } finally {
      setSubmitting(false);
    }
  }

  // ── Step 1: Choose workspace folder ──────────
  if (step === "choose-folder") {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full bg-[var(--background)] px-6">
        <div className="mb-10 text-center select-none">
          <h1
            className="text-4xl font-semibold text-[var(--text-primary)] tracking-tight mb-1"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Cairn
          </h1>
          <p className="text-sm text-[var(--text-tertiary)]">Your personal knowledge base</p>
        </div>

        <div className="w-full max-w-sm bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 flex flex-col gap-5">
          <div>
            <h2 className="text-sm font-medium text-[var(--text-primary)] mb-1">
              Choose a workspace folder
            </h2>
            <p className="text-xs text-[var(--text-tertiary)] leading-relaxed">
              This is where Cairn will save your notes as Markdown files and store project data.
              Pick a folder you can find easily — like Documents or iCloud Drive.
            </p>
          </div>

          {chosenFolder && (
            <div className="flex items-center gap-2 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2">
              <FolderOpen size={14} className="text-[var(--accent)] shrink-0" />
              <span className="text-xs text-[var(--text-secondary)] font-mono truncate">{chosenFolder}</span>
            </div>
          )}

          <button
            type="button"
            disabled={submitting}
            onClick={handleChooseFolder}
            className={[
              "w-full py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2",
              !submitting
                ? "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]"
                : "bg-[var(--surface-2)] text-[var(--text-tertiary)] cursor-not-allowed",
            ].join(" ")}
          >
            <FolderOpen size={14} />
            {submitting ? "Opening…" : "Choose folder"}
          </button>
        </div>
      </div>
    );
  }

  // ── Step 2: Name workspace ────────────────────
  return (
    <div className="flex flex-col items-center justify-center h-full w-full bg-[var(--background)] px-6">
      <div className="mb-10 text-center select-none">
        <h1
          className="text-4xl font-semibold text-[var(--text-primary)] tracking-tight mb-1"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Cairn
        </h1>
        <p className="text-sm text-[var(--text-tertiary)]">Your personal knowledge base</p>
      </div>

      <form
        onSubmit={handleCreateWorkspace}
        className="w-full max-w-sm bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 flex flex-col gap-5"
      >
        <div>
          <div className="flex items-center gap-2 mb-1">
            {initialStep === "choose-folder" && (
              <button
                type="button"
                onClick={() => setStep("choose-folder")}
                className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
              >
                <ArrowLeft size={13} />
              </button>
            )}
            <h2 className="text-sm font-medium text-[var(--text-primary)]">
              Name your workspace
            </h2>
          </div>
          {chosenFolder && (
            <p className="text-xs text-[var(--text-tertiary)] font-mono truncate">{chosenFolder}</p>
          )}
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
