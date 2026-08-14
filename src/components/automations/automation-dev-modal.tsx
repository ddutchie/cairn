"use client";

import React, { useEffect, useRef, useState } from "react";
import { FileText, FolderOpen, Play, RefreshCw, Sparkles } from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AgentChatPane } from "@/components/agent/AgentChatPane";
import { useCairnStore } from "@/store";
import { cn } from "@/lib/utils";
import type { Automation } from "@/store/slices/automations";
import type { TerminalSession } from "@/types";

/**
 * AutomationDevModal — a self-contained agent session for building an
 * automation's scripts. Reuses the full AgentChatPane (transcript + input +
 * tool chips) inside a modal, alongside a live "Files" panel showing what the
 * agent is writing in the automation folder. The session runs the restricted
 * "automation-dev" persona (file tools only) so it can never touch the board.
 */
export function AutomationDevModal({
  automation,
  sessionId,
  onClose,
  onSyncFromManifest,
  syncing,
  onRunNow,
  onStartOver,
}: {
  automation: Automation | null;
  sessionId: string | null;
  onClose: () => void;
  onSyncFromManifest?: () => void;
  syncing?: boolean;
  onRunNow?: () => void;
  onStartOver?: () => void;
}) {
  const session = useCairnStore((s) =>
    sessionId ? (s.terminalSessions.find((t) => t.sessionId === sessionId) ?? null) : null,
  ) as TerminalSession | null;

  return (
    <ModalShell
      open={automation !== null && sessionId !== null}
      onClose={onClose}
      size="full"
      title={
        automation ? (
          <span className="flex items-center gap-2">
            <Sparkles size={13} className="text-[var(--accent)]" />
            <span className="truncate">Develop: {automation.name}</span>
          </span>
        ) : ""
      }
      footer={
        <>
          {onStartOver && (
            <Button variant="ghost" size="sm" onClick={onStartOver} title="Abort this session and start a fresh one">
              <Sparkles size={12} className="mr-1" /> Start over
            </Button>
          )}
          {onSyncFromManifest && (
            <Button variant="outline" size="sm" onClick={onSyncFromManifest} disabled={syncing}>
              <RefreshCw size={12} className={cn("mr-1", syncing && "animate-spin")} /> {syncing ? "Syncing…" : "Sync from manifest"}
            </Button>
          )}
          {onRunNow && (
            <Button variant="accent" size="sm" onClick={onRunNow}>
              <Play size={12} className="mr-1" /> Run now
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="ghost" size="sm">Close</Button>
          </DialogClose>
        </>
      }
    >
      <div className="flex gap-3 h-[65vh] min-h-[420px]">
        <div className="flex-1 min-w-0 rounded-lg border border-[var(--border)] overflow-hidden bg-[var(--surface)]">
          {session ? (
            <AgentChatPane session={session} isActive />
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-[var(--text-tertiary)]">
              Starting agent…
            </div>
          )}
        </div>
        <DevFilesPanel automationId={automation?.id ?? ""} />
      </div>
    </ModalShell>
  );
}

interface FolderFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/** Live file tree of the automation folder — shows what the agent is changing. */
function DevFilesPanel({ automationId }: { automationId: string }) {
  const [files, setFiles] = useState<FolderFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const prevMtimes = useRef<Record<string, number>>({});
  const [changed, setChanged] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!automationId || !window.electron) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await window.electron!.automation.files(automationId);
        if (cancelled) return;
        const prev = prevMtimes.current;
        const nextChanged: Record<string, boolean> = {};
        for (const f of res.files) {
          if (prev[f.path] !== undefined && prev[f.path] !== f.mtimeMs) nextChanged[f.path] = true;
        }
        prevMtimes.current = Object.fromEntries(res.files.map((f) => [f.path, f.mtimeMs]));
        setFiles(res.files);
        setChanged(nextChanged);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
      timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [automationId]);

  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

  return (
    <div className="w-64 shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-[var(--border)] text-[0.714rem] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
        <FolderOpen size={11} /> Files
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {error ? (
          <p className="text-xs text-[var(--danger)]">{error}</p>
        ) : sorted.length === 0 ? (
          <p className="text-xs text-[var(--text-tertiary)]">No files yet — the agent will write scripts here.</p>
        ) : (
          sorted.map((f) => (
            <div
              key={f.path}
              className={cn(
                "flex items-center gap-1.5 rounded px-1.5 py-1 text-[0.714rem] min-w-0",
                changed[f.path]
                  ? "bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent)]"
                  : "text-[var(--text-secondary)]",
              )}
            >
              <FileText size={10} className="shrink-0 text-[var(--text-tertiary)]" />
              <span className="truncate flex-1 font-mono" title={f.path}>{f.path}</span>
              {changed[f.path] && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0 animate-pulse" />}
            </div>
          ))
        )}
      </div>
      <div className="px-2.5 py-1.5 border-t border-[var(--border)] text-[0.65rem] text-[var(--text-tertiary)]">
        {sorted.length} file{sorted.length === 1 ? "" : "s"} · highlights files just written
      </div>
    </div>
  );
}
