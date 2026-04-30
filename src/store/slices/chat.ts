/**
 * Chat slice — threads and messages.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { ChatThread, ChatMessage, PendingAction, ID } from "@/types";
import { id, now } from "@/lib/utils";
import { ipc } from "../ipc";

// ── Slice interface ───────────────────────────────────────────────────────────

export interface ChatSlice {
  chatThreads: ChatThread[];
  chatMessages: ChatMessage[];

  getOrCreateThread: (workspaceId: ID, projectId?: ID) => ChatThread;
  addMessage: (
    threadId: ID,
    role: ChatMessage["role"],
    content: string,
    contextRefs?: ChatMessage["contextRefs"]
  ) => ChatMessage;
  confirmAction: (action: PendingAction) => void;
  deleteThread: (threadId: ID) => void;
  renameThread: (threadId: ID, title: string) => void;
  createNewThread: (workspaceId: ID, projectId?: ID) => ChatThread;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

export const createChatSlice: StateCreator<CairnStore, [], [], ChatSlice> = (
  set,
  get
) => ({
  chatThreads: [],
  chatMessages: [],

  getOrCreateThread(workspaceId, projectId) {
    const existing = get().chatThreads.find(
      (t) =>
        t.workspaceId === workspaceId &&
        (projectId ? t.projectId === projectId : !t.projectId)
    );
    if (existing) return existing;

    const thread: ChatThread = {
      id: id(),
      scope: projectId ? "project" : "workspace",
      workspaceId,
      projectId,
      createdAt: now(),
      updatedAt: now(),
    };
    set((s) => ({ chatThreads: [...s.chatThreads, thread] }));
    get().persist();
    ipc((e) => e.chat.upsertThread(thread));
    return thread;
  },

  addMessage(threadId, role, content, contextRefs) {
    const msg: ChatMessage = {
      id: id(),
      threadId,
      role,
      content,
      contextRefs,
      createdAt: now(),
    };
    set((s) => ({
      chatMessages: [...s.chatMessages, msg],
      chatThreads: s.chatThreads.map((t) =>
        t.id === threadId ? { ...t, updatedAt: now() } : t
      ),
    }));
    get().persist();
    ipc((e) => e.chat.addMessage(msg));
    const thread = get().chatThreads.find((t) => t.id === threadId);
    if (thread) ipc((e) => e.chat.upsertThread({ ...thread, updatedAt: now() }));
    return msg;
  },

  confirmAction(action) {
    const s = get();
    if (action.type === "create_note") {
      const { projectId, title } = action.payload as {
        projectId: ID;
        title: string;
      };
      s.createNote(projectId, title);
    } else if (action.type === "create_task") {
      const { columnId, projectId, title } = action.payload as {
        columnId: ID;
        projectId: ID;
        title: string;
      };
      s.createCard(columnId, projectId, title);
    } else if (action.type === "update_task_status") {
      const { cardId, columnId } = action.payload as {
        cardId: ID;
        columnId: ID;
      };
      s.moveCard(cardId, columnId, 0);
    }
  },

  deleteThread(threadId) {
    set((s) => ({
      chatThreads: s.chatThreads.filter((t) => t.id !== threadId),
      chatMessages: s.chatMessages.filter((m) => m.threadId !== threadId),
    }));
    get().persist();
    ipc((e) => e.chat.deleteThread(threadId));
  },

  renameThread(threadId, title) {
    set((s) => ({
      chatThreads: s.chatThreads.map((t) =>
        t.id === threadId ? { ...t, title: title.trim() || undefined, updatedAt: now() } : t
      ),
    }));
    get().persist();
    const thread = get().chatThreads.find((t) => t.id === threadId);
    if (thread) ipc((e) => e.chat.upsertThread(thread));
  },

  createNewThread(workspaceId, projectId) {
    const thread: ChatThread = {
      id: id(),
      scope: projectId ? "project" : "workspace",
      workspaceId,
      projectId,
      createdAt: now(),
      updatedAt: now(),
    };
    set((s) => ({ chatThreads: [...s.chatThreads, thread] }));
    get().persist();
    ipc((e) => e.chat.upsertThread(thread));
    return thread;
  },
});
