"use client";

import { useShallow } from "zustand/react/shallow";
import { useCairnStore } from "@/store";
import { id } from "@/lib/utils";
import type { AgentMessage, CodingSessionSummary, SessionPresentation, TerminalSession } from "@/types";
import { unwrapSessionPayload } from "@/components/conversation/conversation-session";

/**
 * Shared hook for creating new Cairn Agent sessions and resuming existing ones.
 * Used by both AgentEmptyState and AgentSessionTab.
 */
export function useAgentSessionActions() {
  const {
    addTerminalSession,
    openSession,
    terminalSessions,
    activeProjectId,
    projects,
    upsertCodingSessionSummary,
    setActiveCodingSession,
  } = useCairnStore(useShallow((s) => ({
    addTerminalSession: s.addTerminalSession,
    openSession: s.openSession,
    terminalSessions: s.terminalSessions,
    activeProjectId: s.activeProjectId,
    projects: s.projects,
    upsertCodingSessionSummary: s.upsertCodingSessionSummary,
    setActiveCodingSession: s.setActiveCodingSession,
  })));

  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  async function handleNewSession(
    presentation: SessionPresentation = "drawer",
    initialPrompt?: string,
  ) {
    if (!project?.codeDirectory || !activeProjectId) return;
    const sessionId = id();
    const now = new Date().toISOString();
    const summary: CodingSessionSummary = {
      id: sessionId,
      projectId: activeProjectId,
      taskTitle: "Ad-hoc session",
      taskId: null,
      cwd: project.codeDirectory,
      mode: "execute" as const,
      planNoteId: null,
      planContent: null,
      status: "running" as const,
      spawnedAt: now,
      updatedAt: now,
    };
    try { await window.electron?.session.createSession(summary); } catch (e) {
      console.debug("[useAgentSessionActions] createSession failed:", e);
    }
    addTerminalSession({
      sessionId, taskId: sessionId, taskTitle: "Ad-hoc session",
      agentId: "cairn-agent", agentName: "Cairn Agent",
      projectId: activeProjectId, cwd: project.codeDirectory,
       status: "running", exitCode: null, spawnedAt: now,
       sessionType: "coding", messages: [], mode: "execute", initialPrompt,
    });
    upsertCodingSessionSummary(summary);
    setActiveCodingSession(sessionId);
    openSession(sessionId, "coding", presentation);
  }


  async function handleResumeSession(
    summary: CodingSessionSummary,
    presentation: SessionPresentation = "drawer",
    activate = true,
  ) {
    const alreadyLoaded = terminalSessions.find((t) => t.sessionId === summary.id);
    if (!alreadyLoaded) {
      let messages: AgentMessage[] = [];
      let lastUsage: TerminalSession["lastUsage"] = undefined;
      try {
        type RowType = {
          id: string; role: "user" | "assistant" | "error"; content: string;
          reasoning?: string | null;
          toolCalls: unknown[] | null; subagents: unknown[] | null; timestamp: string;
        };
        const sessRes = await (window.electron?.session as unknown as { getSessionMessages: (id: string) => Promise<unknown> })?.getSessionMessages(summary.id);
        // Shared unwrapper — the same three response shapes the chat history
        // path sees (see unwrapSessionPayload).
        const payload = unwrapSessionPayload(sessRes);
        const rows: RowType[] | undefined = payload.messages.length > 0 ? payload.messages as unknown as RowType[] : undefined;
        lastUsage = payload.usage as TerminalSession["lastUsage"];
        if (payload.todos && payload.todos.length > 0) {
          useCairnStore.getState().setSessionTodos(summary.id, payload.todos.map((t) => ({ content: t.title, status: t.status, priority: "medium" as const })));
        }

        if (rows) {
          messages = rows.map((r) => ({
            id: r.id, role: r.role, content: r.content,
            reasoning: (r.reasoning ?? undefined) as AgentMessage["reasoning"],
            toolCalls: (r.toolCalls ?? undefined) as AgentMessage["toolCalls"],
            subagents: (r.subagents ?? undefined) as AgentMessage["subagents"],
            timestamp: r.timestamp,
          }));
        }
      } catch { /* ok */ }

      window.electron?.session.restoreContext(summary.id);
      addTerminalSession({
        sessionId: summary.id, taskId: summary.taskId ?? summary.id,
        taskTitle: summary.taskTitle, agentId: "cairn-agent", agentName: "Cairn Agent",
        projectId: summary.projectId, cwd: summary.cwd, status: summary.status,
        exitCode: null, spawnedAt: summary.spawnedAt, sessionType: "coding",
        messages, mode: summary.mode, planNoteId: summary.planNoteId ?? undefined,
        planContent: summary.planContent ?? undefined,
        lastUsage,
      });
    } else {


      window.electron?.session.restoreContext(summary.id);
    }
    if (activate) {
      setActiveCodingSession(summary.id);
      openSession(summary.id, "coding", presentation);
    }
  }

  return { handleNewSession, handleResumeSession, project };
}
