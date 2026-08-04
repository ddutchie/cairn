"use client";

import { useRef, useEffect } from "react";
import { ArrowLeft, Check, FolderOpen, ShieldAlert, Sparkles } from "lucide-react";
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
  importPreview?: {
    vaultName: string;
    noteCount: number;
    skippedCount: number;
    projects: { name: string; noteCount: number; root: boolean; projectKey: string }[];
  } | null;
  previewReady?: boolean;
  excludedFolders?: Set<string>;
  onBack: () => void;
  onNameChange: (v: string) => void;
  onIconChange: (v: string) => void;
  onToggleExcludedFolder?: (name: string) => void;
  onRetryPreview?: () => void;
  onSubmit: (e: React.FormEvent) => void;
}

export function StepWorkspaceDetails({
  chosenFolder,
  name,
  icon,
  submitting,
  showBack,
  isObsidianVault = false,
  importPreview = null,
  previewReady = true,
  excludedFolders = new Set(),
  onBack,
  onNameChange,
  onIconChange,
  onToggleExcludedFolder,
  onRetryPreview,
  onSubmit,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const hasImport = (importPreview?.noteCount ?? 0) > 0;
  const includedProjects = importPreview?.projects.filter((project) => project.root || !excludedFolders.has(project.name)) ?? [];
  const includedNotes = includedProjects.reduce((sum, project) => sum + project.noteCount, 0);
  const includedProjectCount = new Set(includedProjects.map((project) => project.projectKey)).size;

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

        {chosenFolder && (isObsidianVault || hasImport || !previewReady) && (
          <div className="flex flex-col gap-3">
            <div role="status" aria-live="polite" className="flex items-start gap-2 bg-[var(--accent-dim)] border border-[color-mix(in_srgb,var(--accent)_35%,transparent)] rounded-lg px-3 py-2">
              <Sparkles size={14} className="text-[var(--accent)] shrink-0 mt-0.5" />
              <div className="text-xs text-[var(--text-secondary)] leading-relaxed">
                <p><span className="font-medium text-[var(--text-primary)]">{isObsidianVault ? "Obsidian vault detected." : "Markdown notes detected."}</span>{" "}
                  {importPreview ? `${includedNotes} notes across ${includedProjectCount} projects are ready to import.` : previewReady ? "No notes found." : "Scanning your folder…"}
                </p>
                {!!importPreview?.skippedCount && <p className="mt-1 text-[var(--text-tertiary)]">{importPreview.skippedCount} template, Excalidraw, or infrastructure files will be skipped.</p>}
              </div>
            </div>

            {!previewReady && !importPreview && (
              <button type="button" onClick={onRetryPreview} className="text-xs font-medium text-[var(--accent)] hover:underline self-start">Retry folder preview</button>
            )}

            {!!importPreview?.projects.length && (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden">
                <div className="px-3 py-2 text-[0.714rem] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">Import preview</div>
                <div className="max-h-36 overflow-y-auto border-t border-[var(--border)]">
                  {importPreview.projects.map((project) => {
                    const excluded = !project.root && excludedFolders.has(project.name);
                    return (
                      <button
                        key={`${project.root ? "root" : "folder"}:${project.name}`}
                        type="button"
                        disabled={project.root}
                        aria-pressed={!excluded}
                        aria-label={project.root ? `${project.name}, vault root, always included` : `${excluded ? "Include" : "Exclude"} ${project.name}`}
                        onClick={() => onToggleExcludedFolder?.(project.name)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left border-b last:border-b-0 border-[var(--border)] hover:bg-[var(--surface-3)] disabled:hover:bg-transparent"
                      >
                        <span className={cn("w-4 h-4 rounded border flex items-center justify-center shrink-0", excluded ? "border-[var(--border)]" : "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]")}>
                          {!excluded && <Check size={11} />}
                        </span>
                        <FolderOpen size={13} className="text-[var(--text-tertiary)]" />
                        <span className={cn("flex-1 text-xs truncate", excluded ? "text-[var(--text-tertiary)] line-through" : "text-[var(--text-primary)]")}>{project.name}{project.root ? " (vault root)" : ""}</span>
                        <span className="text-[0.714rem] text-[var(--text-tertiary)]">{project.noteCount}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex items-start gap-2 rounded-lg border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] px-3 py-2">
              <ShieldAlert size={14} className="text-[var(--warning)] shrink-0 mt-0.5" />
              <p className="text-[0.714rem] leading-relaxed text-[var(--text-secondary)]">Cairn adds its own frontmatter to imported notes. Commit the vault to git or make a backup first so you can review or roll back the first-touch changes.</p>
            </div>
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
          disabled={!name.trim() || submitting || !previewReady}
          className={cn(
            "w-full py-2 rounded-lg text-sm font-medium transition-all",
            name.trim() && !submitting && previewReady
              ? "bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)]"
              : "bg-[var(--surface-2)] text-[var(--text-tertiary)] cursor-not-allowed"
          )}
        >
          {submitting ? "Creating…" : !previewReady ? "Waiting for preview…" : "Create workspace"}
        </button>
      </form>
    </Shell>
  );
}
