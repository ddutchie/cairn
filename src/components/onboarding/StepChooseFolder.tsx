"use client";

import { FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { Shell } from "./shared";

interface Props {
  chosenFolder: string | null;
  submitting: boolean;
  onChoose: () => void;
}

export function StepChooseFolder({ chosenFolder, submitting, onChoose }: Props) {
  return (
    <Shell step="choose-folder">
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
            <span className="text-xs text-[var(--text-secondary)] font-mono truncate">
              {chosenFolder}
            </span>
          </div>
        )}

        <button
          type="button"
          disabled={submitting}
          onClick={onChoose}
          className={cn(
            "w-full py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2",
            !submitting
              ? "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]"
              : "bg-[var(--surface-2)] text-[var(--text-tertiary)] cursor-not-allowed"
          )}
        >
          <FolderOpen size={14} />
          {submitting ? "Opening…" : "Choose folder"}
        </button>
      </div>
    </Shell>
  );
}
