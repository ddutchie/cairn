"use client";

import type { ReactNode } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RefreshSpin } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "./shared";

interface PromptPreviewPanelProps {
  title: string;
  description: string;
  workspacePath?: string | null;
  error?: string | null;
  loading: boolean;
  reload: () => void;
  children: ReactNode;
}

/**
 * Shared shell for the prompt/tools preview panels (Chat + Coding Agent tabs):
 * SettingsGroup card, Refresh row, workspace-path chip, error banner and the
 * loading spinner. Each surface keeps only its prompt + tools bodies.
 */
export function PromptPreviewPanel({
  title,
  description,
  workspacePath,
  error,
  loading,
  reload,
  children,
}: PromptPreviewPanelProps) {
  return (
    <SettingsGroup title={title} description={description}>
      {/* Refresh */}
      <div className="flex items-center justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={reload}
          disabled={loading}
          className={cn(loading && "opacity-50")}
        >
          <RefreshSpin size={11} spinning={loading} />
          Refresh
        </Button>
      </div>

      {/* Workspace path context */}
      {workspacePath && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
          <FolderOpen size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
          <span className="text-xs font-mono text-[var(--text-tertiary)] truncate">{workspacePath}</span>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-4 py-3">
          <p className="text-xs text-[var(--danger)]">{error}</p>
        </div>
      )}

      {children}

      {loading && (
        <div className="py-8 text-center">
          <RefreshSpin size={16} className="mx-auto text-[var(--text-tertiary)] opacity-50" />
        </div>
      )}
    </SettingsGroup>
  );
}
