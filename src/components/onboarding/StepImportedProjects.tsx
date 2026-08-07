"use client";

import { useState } from "react";
import { ArrowLeft, FolderCheck, FileText, Undo2 } from "lucide-react";
import { Shell } from "./shared";

export interface ImportedProject {
  id: string;
  name: string;
  noteCount: number;
}

interface Props {
  projects: ImportedProject[];
  onBack: () => void;
  onContinue: () => void;
  /** Undo the import: remove these projects/notes, strip Cairn frontmatter,
   *  and stop managing the vault. Only offered here, immediately after import. */
  onUndo: () => void;
}

export function StepImportedProjects({ projects, onBack, onContinue, onUndo }: Props) {
  const totalNotes = projects.reduce((sum, p) => sum + p.noteCount, 0);
  // Two-step destructive confirm: first click arms it, second click fires it.
  const [confirming, setConfirming] = useState(false);

  return (
    <Shell step="imported-projects">
      <div className="w-full max-w-sm bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 flex flex-col gap-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <button
              type="button"
              onClick={onBack}
              aria-label="Go back to previous step"
              className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
            >
              <ArrowLeft size={13} />
            </button>
            <h2 className="text-sm font-medium text-[var(--text-primary)]">
              {projects.length === 1 ? "Found 1 project" : `Found ${projects.length} projects`}
            </h2>
          </div>
          <p className="text-xs text-[var(--text-tertiary)]">
            Cairn turned the folders in your vault into projects and imported{" "}
            {totalNotes === 1 ? "1 note" : `${totalNotes} notes`}. You can rename,
            merge, or archive them anytime.
          </p>
        </div>

        {/* Found projects list */}
        <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
          {projects.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-2.5 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2"
            >
              <FolderCheck size={14} className="text-[var(--accent)] shrink-0" />
              <span className="flex-1 min-w-0 text-sm text-[var(--text-primary)] truncate">
                {p.name}
              </span>
              <span className="flex items-center gap-1 text-[0.7rem] text-[var(--text-tertiary)] shrink-0 tabular-nums">
                <FileText size={11} />
                {p.noteCount}
              </span>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={onContinue}
          className="w-full py-2 rounded-lg text-sm font-medium bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-all"
        >
          Looks good — continue
        </button>

        <button
          type="button"
          onClick={() => {
            if (confirming) {
              onUndo();
            } else {
              setConfirming(true);
            }
          }}
          className={confirming
            ? "w-full py-2 rounded-lg text-sm font-medium border border-[var(--danger)] text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] transition-all"
            : "w-full py-2 rounded-lg text-sm font-medium border border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-all"}
        >
          {confirming
            ? `Confirm — undo removes ${projects.length === 1 ? "this project" : `${projects.length} projects`} and strips Cairn frontmatter`
            : (
              <span className="inline-flex items-center justify-center gap-1.5">
                <Undo2 size={12} />
                Undo import — pick a different folder
              </span>
            )}
        </button>
      </div>
    </Shell>
  );
}
