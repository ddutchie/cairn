"use client";

import { Tooltip } from "@/components/ui/tooltip";
import { FileSection } from "./FileSection";
import { FileRow } from "./FileRow";
import { diffKey } from "./git-helpers";
import type { GitStatusEntry } from "@/../shared/types/git";

interface StatusFileSectionProps {
  label: string;
  files: GitStatusEntry[];
  expanded: boolean;
  onToggle: () => void;
  discardArmed: boolean;
  /** Tooltip for the discard button (armed message or idle copy). */
  discardTooltip: string;
  discardIdleLabel: string;
  discardArmedLabel: string;
  onDiscardAll: () => void;
  stageTooltip: string;
  onStageAll: () => void;
  /** Passed to diffKey/handleToggleFile (false for working-tree sections). */
  staged: boolean;
  fileDiffs: Record<string, { added: number; deleted: number; diff: string }>;
  expandedFiles: Set<string>;
  loadingFile: string | null;
  armedDiscardKey: string | null;
  onStageFile: (path: string) => void;
  onDiscardFile: (key: string, paths: string[]) => void;
  onToggleFile: (path: string, staged: boolean) => void;
}

/** Unstaged/untracked FileSection: discard-all + stage-all action bar plus the FileRow map. */
export function StatusFileSection({
  label,
  files,
  expanded,
  onToggle,
  discardArmed,
  discardTooltip,
  discardIdleLabel,
  discardArmedLabel,
  onDiscardAll,
  stageTooltip,
  onStageAll,
  staged,
  fileDiffs,
  expandedFiles,
  loadingFile,
  armedDiscardKey,
  onStageFile,
  onDiscardFile,
  onToggleFile,
}: StatusFileSectionProps) {
  return (
    <FileSection
      label={label}
      count={files.length}
      expanded={expanded}
      onToggle={onToggle}
      action={
        <div className="flex items-center gap-1.5">
          <Tooltip content={discardTooltip}>
            <button
              onClick={onDiscardAll}
              className="text-2xs text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-2 py-0.5 rounded transition-colors cursor-pointer"
            >
              {discardArmed ? discardArmedLabel : discardIdleLabel}
            </button>
          </Tooltip>
          <Tooltip content={stageTooltip}>
            <button
              onClick={onStageAll}
              className="text-2xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] px-2 py-0.5 rounded hover:bg-[var(--surface-3)] transition-colors cursor-pointer"
            >
              Stage all
            </button>
          </Tooltip>
        </div>
      }
    >
      {files.map((file) => {
        const key = diffKey(file.path, staged);
        return (
          <FileRow
            key={file.path}
            path={file.path}
            status={file.status}
            onAction={() => onStageFile(file.path)}
            onDiscard={() => onDiscardFile(`file:${file.path}`, [file.path])}
            discardArmed={armedDiscardKey === `file:${file.path}`}
            actionLabel="+"
            actionColor="var(--success)"
            stat={fileDiffs[key]}
            rawDiff={fileDiffs[key]?.diff ?? ""}
            expanded={expandedFiles.has(key)}
            loading={loadingFile === key}
            onToggle={() => onToggleFile(file.path, staged)}
          />
        );
      })}
    </FileSection>
  );
}
