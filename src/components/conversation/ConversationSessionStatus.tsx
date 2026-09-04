"use client";

import { useEffect, useState } from "react";
import { useCairnStore } from "@/store";
import { AgentGoalChip } from "@/components/agent/AgentGoalChip";
import { AgentJobsDock } from "@/components/agent/AgentJobsDock";
import type {
  GoalSummary,
  JobSummary,
  SessionProjection,
} from "../../../shared/agent/session-projection";

/**
 * ConversationSessionStatus — jobs dock + goal chip for the shared chat pane.
 *
 * Mirrors the coding pane's (`AgentChatPane`) minimal subscription: an initial
 * `session:goal` snapshot on mount, then live `session:projection`
 * kind:`"jobs"` / kind:`"goal"` updates filtered to this session. Jobs reuse
 * the zustand `sessionJobs` map (keyed by sessionId, same owner filter as
 * coding); the goal lives in local state like coding's `sessionGoal`.
 *
 * Both children hide when empty, so this renders nothing until the session
 * has a goal or jobs. `AgentGoalChip` / `AgentJobsDock` are shared as-is —
 * neither is hard-wired to coding-pane store/actions (both take plain props).
 */
export function filterSessionJobs(jobs: JobSummary[], sessionId: string): JobSummary[] {
  return jobs.filter((job) => job.ownerSession == null || job.ownerSession === sessionId);
}

export function ConversationSessionStatus({ sessionId }: { sessionId: string }) {
  const setSessionJobs = useCairnStore((s) => s.setSessionJobs);
  const sessionJobs = useCairnStore((s) => s.sessionJobs[sessionId]);
  const [sessionGoal, setSessionGoal] = useState<GoalSummary | null>(null);

  useEffect(() => {
    const electron = window.electron;
    if (!electron || !sessionId) return;

    // Initial goal snapshot (durable log fold — works before any live agent).
    // A live projection is newer than this in-flight read: once one arrives,
    // the pending snapshot must not clobber it when it settles.
    let cancelled = false;
    let liveUpdate = false;
    void electron.session.goal(sessionId).then((res) => {
      if (cancelled || liveUpdate) return;
      if (res && typeof res === "object" && "ok" in res && res.ok) {
        setSessionGoal((res as { value: GoalSummary | null }).value);
      }
    }).catch(() => undefined);

    const unsubProjection = electron.session.onProjection((projection: SessionProjection) => {
      if (projection.sessionId !== sessionId) return;
      if (projection.kind === "jobs") {
        // Bridge emits the owner's full visible set (owned + unowned); the
        // dock filters to this session's jobs plus unowned ones.
        const jobs = (projection.data as { jobs?: JobSummary[] }).jobs ?? [];
        setSessionJobs(sessionId, filterSessionJobs(jobs, sessionId));
      } else if (projection.kind === "goal") {
        liveUpdate = true;
        setSessionGoal(((projection.data as { goal?: GoalSummary | null }).goal ?? null));
      }
    });

    return () => {
      cancelled = true;
      unsubProjection?.();
    };
  }, [sessionId, setSessionJobs]);

  return (
    <>
      <AgentGoalChip goal={sessionGoal} />
      {(sessionJobs?.length ?? 0) > 0 && <AgentJobsDock jobs={sessionJobs ?? []} />}
    </>
  );
}
