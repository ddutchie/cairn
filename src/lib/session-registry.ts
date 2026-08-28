import type { ChatMessage, ChatThread, CodingSessionSummary, SessionKind, TerminalSession } from "@/types";

export interface SessionSummary {
  id: string;
  sourceId: string;
  kind: SessionKind;
  title: string;
  updatedAt: string;
  projectId: string;
  status?: "running" | "exited";
  mode?: "plan" | "execute";
  messageCount?: number;
}

interface SessionRegistryInput {
  chatThreads: ChatThread[];
  chatMessages: ChatMessage[];
  codingSessions: CodingSessionSummary[];
  terminalSessions: TerminalSession[];
  projectId?: string | null;
}

function sourceIdFor(kind: SessionKind, id: string): string {
  return kind === "chat" ? `chat:${id}` : kind === "coding" ? `coding:${id}` : `terminal:${id}`;
}

// Hoisted — not recreated per call — and strict-null safe.
// Empty string is a real id (not null), so only null/undefined coalesce to the
// same "no-project" bucket. Callers normalize projectId once before filtering.
const sameProject = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a === b;
};

/** Build the unified session list used by navigation surfaces. */
export function buildSessionRegistry({
  chatThreads,
  chatMessages,
  codingSessions,
  terminalSessions,
  projectId,
}: SessionRegistryInput): SessionSummary[] {
  const normalizedProjectId = projectId ?? null;
  const chats: SessionSummary[] = chatThreads
    .filter((thread) => sameProject(thread.projectId, normalizedProjectId))
    .map((thread) => ({
      id: sourceIdFor("chat", thread.id),
      sourceId: thread.id,
      kind: "chat",
      projectId: thread.projectId ?? projectId ?? "",
      title: thread.title || chatMessages.find((message) => message.threadId === thread.id && message.role === "user")?.content.slice(0, 60) || "New chat",
      updatedAt: thread.updatedAt,
      messageCount: chatMessages.filter((message) => message.threadId === thread.id).length,
    }));
  const coding: SessionSummary[] = codingSessions
    .filter((session) => sameProject(session.projectId, normalizedProjectId))
    .map((session) => ({
      id: sourceIdFor("coding", session.id),
      sourceId: session.id,
      kind: "coding",
      projectId: session.projectId,
      title: session.taskTitle || "Coding session",
      updatedAt: session.updatedAt,
      status: session.status,
      mode: session.mode,
    }));
  const terminals: SessionSummary[] = terminalSessions
    .filter((session) => session.sessionType === "pty" && sameProject(session.projectId, normalizedProjectId))
    .map((session) => ({
      id: sourceIdFor("terminal", session.sessionId),
      sourceId: session.sessionId,
      kind: "terminal",
      projectId: session.projectId,
      title: session.taskTitle || session.agentName || "External terminal",
      updatedAt: session.spawnedAt,
      status: session.status,
    }));

  return [...chats, ...coding, ...terminals]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}
