import type { ChatMessage, ChatThread, PiSessionSummary, SessionKind, TerminalSession } from "@/types";

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
  codingSessions: PiSessionSummary[];
  terminalSessions: TerminalSession[];
  projectId?: string | null;
}

function sourceIdFor(kind: SessionKind, id: string): string {
  return kind === "chat" ? `chat:${id}` : kind === "coding" ? `coding:${id}` : `terminal:${id}`;
}

/** Build the unified session list used by navigation surfaces. */
export function buildSessionRegistry({
  chatThreads,
  chatMessages,
  codingSessions,
  terminalSessions,
  projectId,
}: SessionRegistryInput): SessionSummary[] {
  const chats: SessionSummary[] = chatThreads
    .filter((thread) => thread.projectId === projectId)
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
    .filter((session) => session.projectId === projectId)
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
    .filter((session) => session.sessionType === "pty" && session.projectId === projectId)
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
