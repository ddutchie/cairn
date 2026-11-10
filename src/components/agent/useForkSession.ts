"use client";

import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCairnStore } from "@/store";
import { ipcResult } from "@/store/ipc";
import { id } from "@/lib/utils";
import type { ChatMessage, CodingSessionSummary } from "@/types";
import { chatSessionId } from "../../../shared/agent/session-identity";
import { useAgentSessionActions } from "./useAgentSessionActions";

export type ForkTarget = "chat" | "coding";

/** The session a fork starts from. */
export type ForkSource = { kind: "chat"; threadId: string } | { kind: "coding"; sessionId: string };

/** Which forks a session allows. A coding session never forks into a chat. */
export interface ForkOptions {
  /** Null when the session cannot be forked (an automation session, or one that is not loaded). */
  source: "chat" | "coding" | null;
  toChat: boolean;
  toCoding: boolean;
  /** Why "coding session" is off, when it is. */
  codingBlocked?: string;
}

const forkTitle = (title: string | null | undefined, fallback: string) => `${title?.trim() || fallback} (fork)`;

const fail = (message: string) => window.dispatchEvent(new CustomEvent("cairn:ipc-error", { detail: { message } }));

/**
 * Fork a chat or coding session: the new session starts with a copy of the conversation and the
 * two then go their own way.
 */
export function useForkSession(source: ForkSource) {
  const [forking, setForking] = useState(false);
  const { handleResumeSession } = useAgentSessionActions();
  const state = useCairnStore(useShallow((s) => ({
    activeProjectId: s.activeProjectId,
    chatThreads: s.chatThreads,
    terminalSessions: s.terminalSessions,
    projects: s.projects,
    projectedTitles: s.projectedTitles,
  })));

  const thread = source.kind === "chat" ? state.chatThreads.find((t) => t.id === source.threadId) : undefined;
  const coding = source.kind === "coding" ? state.terminalSessions.find((t) => t.sessionId === source.sessionId && t.sessionType === "coding" && t.role !== "automation-dev") : undefined;
  // A chat forks into the code folder of its own project, or of the project that is open.
  const codeProject = thread ? state.projects.find((p) => p.id === (thread.projectId ?? state.activeProjectId)) : undefined;

  const options: ForkOptions = thread
    ? { source: "chat", toChat: true, toCoding: !!codeProject?.codeDirectory, codingBlocked: codeProject?.codeDirectory ? undefined : "Set a code folder for the project first" }
    : coding
      ? { source: "coding", toChat: false, toCoding: true }
      : { source: null, toChat: false, toCoding: false };

  async function forkToChat() {
    if (!thread) return;
    const store = useCairnStore.getState();
    const next = store.createNewThread(thread.workspaceId, thread.projectId);
    const res = await ipcResult((e) => e.session.forkSession(chatSessionId(thread.id), chatSessionId(next.id)));
    if ("error" in res) {
      void store.deleteThread(next.id);
      fail(`Fork failed: ${res.error}`);
      return;
    }
    const loaded = await ipcResult((e) => e.chat.sessionMessages(next.id));
    const messages = "data" in loaded ? (loaded.data.messages as ChatMessage[]) : [];
    useCairnStore.setState((s) => ({ chatMessages: [...s.chatMessages.filter((m) => m.threadId !== next.id), ...messages] }));
    store.renameThread(next.id, forkTitle(state.projectedTitles[thread.id] ?? thread.title, "Chat"));
    store.openSession(next.id, "chat", store.sessionPresentation);
  }

  async function forkToCoding() {
    const projectId = coding?.projectId ?? codeProject?.id;
    const cwd = coding?.cwd ?? codeProject?.codeDirectory;
    const from = coding?.sessionId ?? (thread ? chatSessionId(thread.id) : undefined);
    if (!projectId || !cwd || !from) return;
    const store = useCairnStore.getState();
    const now = new Date().toISOString();
    const summary: CodingSessionSummary = {
      id: id(), projectId, cwd,
      taskTitle: forkTitle(coding ? coding.taskTitle : (thread && (state.projectedTitles[thread.id] ?? thread.title)), coding ? "Session" : "Chat"),
      taskId: null, mode: "execute", planNoteId: null, planContent: null, status: "running", spawnedAt: now, updatedAt: now,
    };
    const res = await ipcResult((e) => e.session.forkSession(from, summary.id, cwd));
    if ("error" in res) { fail(`Fork failed: ${res.error}`); return; }
    const row = await ipcResult((e) => e.session.createSession(summary));
    if ("error" in row) {
      // The log is already copied: remove it, or it stays on disk and searchable with no session to open.
      void ipcResult((e) => e.session.deleteSession(summary.id));
      fail(`Fork failed: ${row.error}`);
      return;
    }
    store.upsertCodingSessionSummary(summary);
    // Resuming reads the transcript back from the copied log.
    await handleResumeSession(summary, store.sessionPresentation);
  }

  async function fork(target: ForkTarget) {
    if (forking || (target === "chat" ? !options.toChat : !options.toCoding)) return;
    setForking(true);
    try { await (target === "chat" ? forkToChat() : forkToCoding()); } finally { setForking(false); }
  }

  return { options, fork, forking };
}
