"use client";

import { useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCairnStore } from "@/store";
import type { PiSessionSummary, SessionKind, SessionPresentation } from "@/types";
import { useAgentSessionActions } from "./useAgentSessionActions";

export interface SessionNavigationTarget {
  sourceId: string;
  kind: SessionKind;
  projectId: string;
}

/**
 * Owns the UI-side open flow for persisted conversations. Selection happens
 * immediately, Coding history hydrates asynchronously, and only the latest
 * request may finish by activating its session.
 */
export function useSessionNavigation() {
  const {
    activeProjectId,
    piSessionHistory,
    openSession: selectSession,
    setActiveProject,
    setPersistentPiSession,
  } = useCairnStore(useShallow((s) => ({
    activeProjectId: s.activeProjectId,
    piSessionHistory: s.piSessionHistory,
    openSession: s.openSession,
    setActiveProject: s.setActiveProject,
    setPersistentPiSession: s.setPersistentPiSession,
  })));
  const { handleResumeSession } = useAgentSessionActions();
  const requestRef = useRef(0);

  async function openSession(
    target: SessionNavigationTarget,
    presentation: SessionPresentation,
  ): Promise<boolean> {
    const request = ++requestRef.current;
    if (target.projectId && target.projectId !== activeProjectId) {
      setActiveProject(target.projectId);
    }

    selectSession(target.sourceId, target.kind, presentation);

    if (target.kind !== "coding") return true;

    const summary = piSessionHistory.find((candidate: PiSessionSummary) => candidate.id === target.sourceId);
    if (summary) await handleResumeSession(summary, presentation, false);
    if (request !== requestRef.current) return false;

    // Re-assert the selection after hydration. The loader intentionally does
    // not activate so an older request can never steal the current session.
    setPersistentPiSession(target.sourceId);
    selectSession(target.sourceId, target.kind, presentation);
    return true;
  }

  return { openSession };
}
