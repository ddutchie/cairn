"use client";

import { useShallow } from "zustand/react/shallow";
import { useCairnStore } from "@/store";
import { id } from "@/lib/utils";
import type { PiSessionSummary, PiAgentMessage, TerminalSession } from "@/types";

/**
 * Shared hook for creating new Cairn Agent sessions and resuming existing ones.
 * Used by both AgentEmptyState and AgentSessionTab.
 */
export function useAgentSessionActions() {
  const {
    addTerminalSession,
    setActiveSession,
    terminalSessions,
    activeProjectId,
    projects,
    upsertPiSessionSummary,
    setPersistentPiSession,
  } = useCairnStore(useShallow((s) => ({
    addTerminalSession: s.addTerminalSession,
    setActiveSession: s.setActiveSession,
    terminalSessions: s.terminalSessions,
    activeProjectId: s.activeProjectId,
    projects: s.projects,
    upsertPiSessionSummary: s.upsertPiSessionSummary,
    setPersistentPiSession: s.setPersistentPiSession,
  })));

  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  async function handleNewSession() {
    if (!project?.codeDirectory || !activeProjectId) return;
    const sessionId = id();
    const now = new Date().toISOString();
    const summary: PiSessionSummary = {
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
    try { await window.electron?.piAgent.createSession(summary); } catch (e) {
      console.debug("[useAgentSessionActions] createSession failed:", e);
    }
    addTerminalSession({
      sessionId, taskId: sessionId, taskTitle: "Ad-hoc session",
      agentId: "cairn-agent", agentName: "Cairn Agent",
      projectId: activeProjectId, cwd: project.codeDirectory,
      status: "running", exitCode: null, spawnedAt: now,
      sessionType: "pi", piMessages: [], mode: "execute",
    });
    upsertPiSessionSummary(summary);
    setPersistentPiSession(sessionId);
    setActiveSession(sessionId);
  }


  async function handleResumeSession(summary: PiSessionSummary) {
    const alreadyLoaded = terminalSessions.find((t) => t.sessionId === summary.id);
    if (!alreadyLoaded) {
      let piMessages: PiAgentMessage[] = [];
      let lastUsage: TerminalSession["lastUsage"] = undefined;
      try {
        type RowType = {
          id: string; role: "user" | "assistant" | "error"; content: string;
          reasoning?: string | null;
          toolCalls: unknown[] | null; subagents: unknown[] | null; timestamp: string;
        };
        const sessRes = await (window.electron?.piAgent as unknown as { getSessionMessages: (id: string) => Promise<unknown> })?.getSessionMessages(summary.id);
        let rows: RowType[] | undefined = undefined;

        if (Array.isArray(sessRes)) {
          rows = sessRes as RowType[];
        } else if (sessRes && typeof sessRes === "object") {
          const raw = "data" in sessRes && (sessRes as { data?: unknown }).data ? (sessRes as { data: unknown }).data : sessRes;
          if (Array.isArray(raw)) {
            rows = raw as RowType[];
          } else if (raw && typeof raw === "object" && "messages" in raw && Array.isArray((raw as { messages?: unknown }).messages)) {
            rows = (raw as { messages: RowType[] }).messages;
            lastUsage = (raw as { usage?: TerminalSession["lastUsage"] }).usage;
            const rawTodos = (raw as { todos?: Array<{ id: string; title: string; status: "pending" | "in_progress" | "completed" }> }).todos;
            if (rawTodos && rawTodos.length > 0) {
              useCairnStore.getState().setPiSessionTodos(summary.id, rawTodos.map((t) => ({ content: t.title, status: t.status, priority: "medium" as const })));
            }
          }
        }

        if (rows) {
          piMessages = rows.map((r) => ({
            id: r.id, role: r.role, content: r.content,
            reasoning: (r.reasoning ?? undefined) as PiAgentMessage["reasoning"],
            toolCalls: (r.toolCalls ?? undefined) as PiAgentMessage["toolCalls"],
            subagents: (r.subagents ?? undefined) as PiAgentMessage["subagents"],
            timestamp: r.timestamp,
          }));
        }
      } catch { /* ok */ }

      window.electron?.piAgent.restoreContext(summary.id);
      addTerminalSession({
        sessionId: summary.id, taskId: summary.taskId ?? summary.id,
        taskTitle: summary.taskTitle, agentId: "cairn-agent", agentName: "Cairn Agent",
        projectId: summary.projectId, cwd: summary.cwd, status: summary.status,
        exitCode: null, spawnedAt: summary.spawnedAt, sessionType: "pi",
        piMessages, mode: summary.mode, planNoteId: summary.planNoteId ?? undefined,
        planContent: summary.planContent ?? undefined,
        lastUsage,
      });
    } else {


      window.electron?.piAgent.restoreContext(summary.id);
    }
    setPersistentPiSession(summary.id);
    setActiveSession(summary.id);
  }

  return { handleNewSession, handleResumeSession, project };
}
