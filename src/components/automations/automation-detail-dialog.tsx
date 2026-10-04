"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Pencil, Activity, FileText, Kanban, Sparkles } from "lucide-react";
import { RefreshSpin } from "@/components/ui/spinner";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn, formatRelative } from "@/lib/utils";
import { revealNote, revealCard } from "@/lib/events";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { DialogClose } from "@/components/ui/dialog";
import { ModalShell } from "@/components/ui/modal-shell";
import { EnvEditor } from "./env-editor";
import type { Automation, AutomationRun } from "@/store/slices/automations";
import { RUN_TIME, STATUS_COLOR, scheduleLabel, runScratchArtifacts, type ArtifactRef } from "./automation-format";

interface AutomationDetailDialogProps {
  automation: Automation | null;
  onOpenChange: (open: boolean) => void;
  runs: AutomationRun[];
  onEdit?: () => void;
  onRunNow?: () => void;
  onDevelop?: () => void;
  developing?: boolean;
  onSyncFromManifest?: () => void;
  syncing?: boolean;
  syncStatus?: string | null;
  onEnvChanged?: () => void;
  projectName: string | null;
}

export function AutomationDetailDialog({ automation, onOpenChange, runs, onEdit, onRunNow, onDevelop, developing, onSyncFromManifest, syncing, syncStatus, onEnvChanged, projectName }: AutomationDetailDialogProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [logFor, setLogFor] = useState<string | null>(null);
  const [runLog, setRunLog] = useState<unknown | null>(null);
  const { fetchRuns, setView } = useCairnStore(useShallow((s) => ({ fetchRuns: s.fetchRuns, setView: s.setView })));

  useEffect(() => {
    if (automation) void fetchRuns(automation.id);
  }, [automation, fetchRuns]);

  // The run whose log is being shown; a slower earlier request must not
  // overwrite the log of a run selected after it.
  const logForRef = useRef<string | null>(null);

  async function toggleLog(runId: string) {
    if (logFor === runId) { logForRef.current = null; setLogFor(null); setRunLog(null); return; }
    logForRef.current = runId;
    setLogFor(runId);
    setRunLog(null);
    let next: unknown;
    try {
      const res = await window.electron?.automation.runLog(runId) as { log?: unknown } | { error?: string } | undefined;
      next = res && "log" in (res ?? {}) ? (res as { log: unknown }).log : (res as { error?: string })?.error ?? null;
    } catch (err) {
      next = err instanceof Error ? err.message : String(err);
    }
    if (logForRef.current === runId) setRunLog(next);
  }

  async function refresh() {
    if (!automation) return;
    setRefreshing(true);
    try { await fetchRuns(automation.id); } finally { setRefreshing(false); }
  }

  // Aggregate notes/cards created across all fetched runs, newest run first, dedup by id.
  const artifacts = useMemo<ArtifactRef[]>(() => {
    const seen = new Set<string>();
    const out: ArtifactRef[] = [];
    for (const r of runs) {
      for (const art of runScratchArtifacts(r)) {
        if (seen.has(art.id)) continue;
        seen.add(art.id);
        out.push(art);
      }
    }
    return out;
  }, [runs]);

  return (
    <ModalShell
      open={automation !== null}
      onClose={() => onOpenChange(false)}
      size="lg"
      title={
        automation ? (
          <span className="flex items-center gap-2">
            <Activity size={13} className="text-[var(--accent)]" />
            <span className="truncate">{automation.name}</span>
          </span>
        ) : ""
      }
      scrollable
      footer={
        <>
          {onDevelop && (
            <Button variant="outline" size="sm" onClick={onDevelop} disabled={developing}>
              <Sparkles size={12} className="mr-1" /> {developing ? "Starting…" : "Develop"}
            </Button>
          )}
          {onEdit && (
            <Button variant="outline" size="sm" onClick={onEdit}>
              <Pencil size={12} className="mr-1" /> Edit
            </Button>
          )}
          {onSyncFromManifest && (
            <Button variant="outline" size="sm" onClick={onSyncFromManifest} disabled={syncing}>
              <RefreshSpin size={12} spinning={syncing} className="mr-1" /> {syncing ? "Syncing…" : "Sync from manifest"}
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
      {automation && (
        <div className="space-y-4">
          {syncStatus && (
            <div className={cn(
              "rounded-md border px-2.5 py-1.5 text-xs",
              syncStatus.startsWith("Synced")
                ? "border-[var(--ok)]/40 bg-[color-mix(in_srgb,var(--ok)_8%,transparent)] text-[var(--ok)]"
                : "border-[var(--danger)]/40 bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] text-[var(--danger)]",
            )}>
              {syncStatus}
            </div>
          )}
          {automation.description && (
            <p className="text-xs text-[var(--text-secondary)]">{automation.description}</p>
          )}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <InfoRow label="Schedule" value={scheduleLabel(automation)} />
            <InfoRow label="Project" value={automation.projectId ? projectName ?? "—" : "Workspace (all projects)"} />
            <InfoRow label="Next run" value={formatRelative(automation.nextRunAt, RUN_TIME)} />
            <InfoRow label="Total runs" value={`${automation.runCount}${automation.maxRuns ? ` / max ${automation.maxRuns}` : ""}`} />
            <InfoRow label="Approval" value={automation.approvalMode === "ask" ? "Ask" : "Auto"} />
            <InfoRow label="Status" value={automation.enabled ? "Enabled" : "Disabled"} />
            {automation.requires.length > 0 && (
              <InfoRow label="Needs" value={automation.requires.map((r) => r.name).join(", ")} />
            )}
            {automation.timezone && <InfoRow label="Timezone" value={automation.timezone} />}
          </div>

          <div className="rounded-md border border-[var(--border)] px-3 py-2.5">
            <EnvEditor automationId={automation.id} onChanged={onEnvChanged} />
          </div>

          <div>
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] block mb-2">Artifacts</span>
            {artifacts.length === 0 ? (
              <p className="text-xs text-[var(--text-tertiary)]">No notes or cards created yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {artifacts.map((art) => (
                  <Tooltip key={art.id} content={`Open ${art.type === "note" ? "note" : "task"}`}>
                    <button
                      onClick={() => (art.type === "note" ? revealNote(setView, art.id) : revealCard(setView, art.id))}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors max-w-64"
                    >
                      {art.type === "note" ? <FileText size={11} className="shrink-0" /> : <Kanban size={11} className="shrink-0" />}
                      <span className="truncate">{art.title}</span>
                    </button>
                  </Tooltip>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Run history</span>
              <Button variant="ghost" size="xs" onClick={() => void refresh()} disabled={refreshing}>
                <RefreshSpin size={11} spinning={refreshing} className="mr-1" /> Refresh
              </Button>
            </div>
            <div className="space-y-1.5 max-h-56 overflow-y-auto">
              {runs.length === 0 && (
                <p className="text-xs text-[var(--text-tertiary)]">No runs yet — it will fire on its schedule or you can run it now.</p>
              )}
              {runs.map((r) => (
                <div key={r.id} className="rounded-md border border-[var(--border)] px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={cn("capitalize font-medium", STATUS_COLOR[r.status])}>{r.status}</span>
                    <span className="text-[var(--text-tertiary)] ml-auto">{formatRelative(r.startedAt, RUN_TIME)}</span>
                    {r.status === "error" && onRunNow && r.id === runs[0]?.id && (
                      <Tooltip content="Run this automation again now">
                        <button type="button" onClick={onRunNow} className="text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors text-[0.714rem]">
                          Retry
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip content={logFor === r.id ? "Hide run log" : "Show what happened in this run"}>
                      <button
                        type="button"
                        onClick={() => void toggleLog(r.id)}
                        className="text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors"
                      >
                        <Activity size={11} />
                      </button>
                    </Tooltip>
                  </div>
                  {(r.status === "done" || r.status === "exhausted") && r.finishedAt && (
                    <div className="text-[var(--text-tertiary)] mt-0.5">Finished {formatRelative(r.finishedAt, RUN_TIME)}</div>
                  )}
                  {r.error && (
                    <div className="text-[var(--danger)] mt-0.5 break-words">{r.error}</div>
                  )}
                  {logFor === r.id && <RunLogView log={runLog} />}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

interface RunLogShape {
  status?: string;
  recipe?: string;
  error?: string | null;
  tools?: Array<{ name: string; label?: string; ok?: boolean; output?: string; error?: string }>;
  tokens?: string;
  thoughts?: string;
}

/** Renders a run's persisted transcript (run-log.json). */
function RunLogView({ log }: { log: unknown }) {
  if (log === null) {
    return <p className="text-[var(--text-tertiary)] mt-1.5">No run transcript for this run.</p>;
  }
  if (typeof log === "string") {
    return <p className="text-[var(--danger)] mt-1.5">{log}</p>;
  }
  const l = log as RunLogShape;
  return (
    <div className="mt-1.5 space-y-1.5">
      {l.recipe && (
        <div>
          <div className="text-[var(--text-tertiary)]">Recipe</div>
          <div className="text-[var(--text-secondary)] whitespace-pre-wrap break-words">{l.recipe}</div>
        </div>
      )}
      {l.error && <div className="text-[var(--danger)]">{l.error}</div>}
      {(l.tools ?? []).length > 0 && (
        <div>
          <div className="text-[var(--text-tertiary)]">Tools ({l.tools!.length})</div>
          {l.tools!.map((t, i) => (
            <div key={i} className="mt-1">
              <div className="flex items-center gap-1.5">
                <span className={cn("font-mono", t.ok === false ? "text-[var(--danger)]" : "text-[var(--text-primary)]")}>{t.label ?? t.name}</span>
                {t.ok === false && <span className="text-[var(--danger)]">failed</span>}
                {t.ok === true && <span className="text-[var(--ok)]">ok</span>}
              </div>
              {t.output && (
                <pre className="mt-0.5 text-[0.65rem] text-[var(--text-tertiary)] whitespace-pre-wrap font-mono max-h-32 overflow-y-auto rounded bg-[var(--surface-2)] p-1.5">{t.output}</pre>
              )}
              {t.error && <div className="text-[var(--danger)]">{t.error}</div>}
            </div>
          ))}
        </div>
      )}
      {l.tokens && (
        <div>
          <div className="text-[var(--text-tertiary)]">Assistant output</div>
          <div className="text-[var(--text-secondary)] whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{l.tokens}</div>
        </div>
      )}
      {l.thoughts && (
        <details>
          <summary className="text-[var(--text-tertiary)] cursor-pointer">Thinking</summary>
          <pre className="text-[0.65rem] text-[var(--text-tertiary)] whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">{l.thoughts}</pre>
        </details>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[0.714rem] text-[var(--text-tertiary)]">{label}</div>
      <div className="text-[var(--text-primary)] truncate">{value}</div>
    </div>
  );
}
