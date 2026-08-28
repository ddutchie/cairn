"use client";

import { useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCairnStore } from "@/store";
import type { CodingSessionSummary, SessionKind, SessionPresentation } from "@/types";
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
    codingSessionHistory,
    openSession: selectSession,
    setActiveProject,
    setActiveCodingSession,
    setSessionLoad,
  } = useCairnStore(useShallow((s) => ({
    activeProjectId: s.activeProjectId,
    codingSessionHistory: s.codingSessionHistory,
    openSession: s.openSession,
    setActiveProject: s.setActiveProject,
    setActiveCodingSession: s.setActiveCodingSession,
    setSessionLoad: s.setSessionLoad,
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
    setSessionLoad({ status: "loading", sessionId: target.sourceId });

    if (target.kind !== "coding") {
      setSessionLoad({ status: "ready", sessionId: target.sourceId });
      return true;
    }

    try {
      const summary = codingSessionHistory.find((candidate: CodingSessionSummary) => candidate.id === target.sourceId);
      if (summary) await handleResumeSession(summary, presentation, false);
    } catch (error) {
      if (request === requestRef.current) {
        setSessionLoad({
          status: "error",
          sessionId: target.sourceId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return false;
    }
    if (request !== requestRef.current) return false;

    // Re-assert the selection after hydration. The loader intentionally does
    // not activate so an older request can never steal the current session.
    setActiveCodingSession(target.sourceId);
    selectSession(target.sourceId, target.kind, presentation);
    setSessionLoad({ status: "ready", sessionId: target.sourceId });
    return true;
  }

  return { openSession };
}
