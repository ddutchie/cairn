/**
 * Chat slice — threads and messages.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { ChatThread, ChatMessage, ChatToolCallRecord, PendingAction, ID, TokenBreakdown } from "@/types";
import { id, now } from "@/lib/utils";
import { ipc, ipcAwait, ipcAwaitResult } from "../ipc";

// ── Slice interface ───────────────────────────────────────────────────────────

export interface ChatSlice {
  chatThreads: ChatThread[];
  chatMessages: ChatMessage[];
  activeChatThreadId: string | null;

  getOrCreateThread: (workspaceId: ID, projectId?: ID) => ChatThread;
  setActiveChatThreadId: (threadId: string | null) => void;
  addMessage: (
    threadId: ID,
    role: ChatMessage["role"],
    content: string,
    contextRefs?: ChatMessage["contextRefs"],
    toolCalls?: ChatToolCallRecord[],
    actions?: ChatMessage["actions"],
    reasoning?: string,
    images?: ChatMessage["images"],
    subagents?: ChatMessage["subagents"],
  ) => ChatMessage;
  confirmAction: (action: PendingAction) => void;
  deleteThread: (threadId: ID) => void;
  renameThread: (threadId: ID, title: string) => void;
  createNewThread: (workspaceId: ID, projectId?: ID) => ChatThread;
  compactChatThread: (threadId: ID) => Promise<void>;
  clearThreadMessages: (threadId: ID) => Promise<void>;
  setThreadUsage: (threadId: ID, usage: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens?: number;
    breakdown?: TokenBreakdown;
  } | undefined) => void;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

export const createChatSlice: StateCreator<CairnStore, [], [], ChatSlice> = (
  set,
  get
) => ({
  chatThreads: [],
  chatMessages: [],
  activeChatThreadId: null,

  setActiveChatThreadId(threadId) {
    set({ activeChatThreadId: threadId });
  },

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

  addMessage(threadId, role, content, contextRefs, toolCalls, actions, reasoning, images, subagents) {
    const msg: ChatMessage = {
      id: id(),
      threadId,
      role,
      content,
      reasoning: reasoning || undefined,
      contextRefs,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      actions: actions && actions.length > 0 ? actions : undefined,
      images: images && images.length > 0 ? images : undefined,
      subagents: subagents && subagents.length > 0 ? subagents : undefined,
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

  async compactChatThread(threadId) {
    const messages = get().chatMessages.filter((m) => m.threadId === threadId);
    if (messages.length < 4) {
      return;
    }
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    const aiConfig = get().aiConfig;

    const tempId = id();
    const tempMsg: ChatMessage = {
      id: tempId,
      threadId,
      role: "system",
      content: "Compacting chat history...",
      createdAt: now(),
    };
    set((s) => ({ chatMessages: [...s.chatMessages, tempMsg] }));

    const result = await ipcAwaitResult<{ summary: string }>(async (e) => {
      try {
        const summaryObj = await e.chat.compactThread({
          messages: history,
          config: {
            provider: aiConfig.provider,
            baseUrl: aiConfig.baseUrl,
            model: aiConfig.model,
            apiKey: aiConfig.apiKey,
          },
        }) as { summary: string };

        return { data: summaryObj };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: msg };
      }
    });

    if (result && "data" in result && result.data?.summary) {
      const summary = result.data.summary;
      const firstUserMsg = messages.find((m) => m.role === "user");
      const summaryMsg: ChatMessage = {
        id: id(),
        threadId,
        role: "system",
        content: `[Earlier conversation summarised to fit the context window]\n\n## Session Summary\n\n${summary}\n\n[End of summary — continuing from current state]`,
        createdAt: now(),
      };

      set((s) => ({
        chatMessages: [
          ...s.chatMessages.filter((m) => m.threadId !== threadId),
          ...(firstUserMsg ? [firstUserMsg] : []),
          summaryMsg,
        ],
      }));
      get().persist();

      await ipcAwait((e) => e.chat.clearThreadMessages(threadId));
      if (firstUserMsg) {
        await ipcAwait((e) => e.chat.addMessage(firstUserMsg));
      }
      await ipcAwait((e) => e.chat.addMessage(summaryMsg));
    } else {
      set((s) => ({
        chatMessages: s.chatMessages.filter((m) => m.id !== tempId),
      }));
    }
  },

  async clearThreadMessages(threadId) {
    set((s) => ({
      chatMessages: s.chatMessages.filter((m) => m.threadId !== threadId),
      chatThreads: s.chatThreads.map((t) =>
        t.id === threadId ? { ...t, lastUsage: undefined, updatedAt: now() } : t
      ),
    }));
    get().persist();
    await ipcAwait((e) => e.chat.clearThreadMessages(threadId));
  },

  setThreadUsage(threadId, usage) {
    set((s) => ({
      chatThreads: s.chatThreads.map((t) =>
        t.id === threadId ? { ...t, lastUsage: usage } : t
      ),
    }));
    get().persist();
  },
});
