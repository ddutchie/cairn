"use client";

/**
 * AgentJobsDock — live background-job list for an agent session.
 *
 * Rendered above the input area in AgentChatPane alongside AgentTodoDock.
 * Data comes from the jobs bridge (`electron/cordis/jobs-bridge.ts` → 
 * `session:projection kind:"jobs"`): one-shot `run_in_background` and
 * continuable `delegate` work the model started. Previously this work was
 * invisible — completions only reached the model inbox.
 *
 * Live jobs offer Kill (via `session:job-kill`, past the ownership fence with
 * the stashed owner agent); settled jobs render dimmed with their outcome.
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { JobSummary } from "@/../shared/agent/session-projection";

interface AgentJobsDockProps {
  jobs: JobSummary[];
  live?: boolean;
}

const TERMINAL = new Set(["completed", "killed", "failed"]);

function formatElapsed(startedAt: number, finishedAt?: number): string {
  const ms = Math.max(0, (finishedAt ?? Date.now()) - startedAt);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function AgentJobsDock({ jobs, live = true }: AgentJobsDockProps) {
  const [expanded, setExpanded] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);

  const running = useMemo(() => jobs.filter((j) => !TERMINAL.has(j.status)), [jobs]);
  const active = useMemo(
    () => running[0] ?? [...jobs].reverse().find((j) => TERMINAL.has(j.status)) ?? jobs[0],
    [jobs, running],
  );

  if (jobs.length === 0) return null;

  const summary = `[${jobs.length} job${jobs.length === 1 ? "" : "s"}${active ? ` - ${active.label}` : ""}]`;

  const onKill = async (jobId: string) => {
    setKillError(null);
    try {
      const res = await window.electron?.session.killJob(jobId);
      if (res && typeof res === "object" && "ok" in res && !(res as { ok: boolean }).ok) {
        const { code, message } = res as { ok: false; code: string; message: string };
        setKillError(code === "owner-unavailable" ? "Can't stop: owning turn ended" : `Can't stop: ${message}`);
      }
      // On success the bridge re-emits the shrunken list — no local update needed.
    } catch (err) {
      setKillError(err instanceof Error ? err.message : "Kill failed");
    }
  };

  return (
    <div className="border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0">
      {expanded && (
        <div className="px-3 pt-2 pb-1 flex flex-col gap-0.5 max-h-52 overflow-y-auto">
          {jobs.map((job) => {
            const settled = TERMINAL.has(job.status);
            return (
              <div key={job.id} className="flex items-center gap-2 py-0.5">
                <span
                  title={job.status}
                  className={cn(
                    "w-2 h-2 rounded-full shrink-0",
                    job.status === "running" && "bg-[var(--accent)] animate-pulse",
                    job.status === "stopping" && "bg-[var(--warning)]",
                    job.status === "completed" && "bg-[var(--success)]",
                    (job.status === "killed" || job.status === "failed") && "bg-[var(--danger)]",
                  )}
                />
                <span className={cn("text-[0.714rem] leading-relaxed flex-1 truncate", settled ? "text-[var(--text-tertiary)]" : "text-[var(--text-primary)] font-medium")}>
                  {job.label}
                  <span className="text-[var(--text-tertiary)]"> · {job.kind} · {job.status} · {formatElapsed(job.startedAt, job.finishedAt)}</span>
                  {job.detail && <span className="text-[var(--text-tertiary)]"> · {job.detail}</span>}
                </span>
                {!settled && live && (
                  <button
                    onClick={() => void onKill(job.id)}
                    title={`Stop ${job.label}`}
                    className="flex items-center gap-1 text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-colors shrink-0"
                  >
                    <X size={12} /> Stop
                  </button>
                )}
              </div>
            );
          })}
          {killError && <div className="text-[0.714rem] text-[var(--danger)] px-1 py-0.5">{killError}</div>}
        </div>
      )}

      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--surface-2)] transition-colors text-left"
        title={expanded ? "Collapse jobs" : "Expand jobs"}
      >
        <span
          className={cn(
            "text-[0.714rem] font-medium flex-1 truncate",
            live && running.length > 0 ? "text-[var(--text-secondary)]" : "text-[var(--text-tertiary)]",
          )}
        >
          {summary}
        </span>
        {expanded
          ? <ChevronDown size={10} className="text-[var(--text-tertiary)] shrink-0" />
          : <ChevronUp size={10} className="text-[var(--text-tertiary)] shrink-0" />}
      </button>
    </div>
  );
}
