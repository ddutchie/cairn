import type { StateCreator } from "zustand";
import type { AppStore } from "../index";
import type { ChatThread, ChatMessage } from "../../../src/types/index";
import * as queries from "../../db/queries";
import { customAlphabet } from "nanoid/non-secure";

const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 12);
const now = () => new Date().toISOString();

export interface ChatSlice {
  threads: ChatThread[];
  activeThread: ChatThread | null;
  messages: ChatMessage[];

  loadThreads: (workspaceId: string, projectId?: string) => Promise<void>;
  selectThread: (thread: ChatThread) => Promise<void>;
  createThread: (workspaceId: string, projectId?: string, title?: string) => Promise<ChatThread>;
  clearActiveThread: () => void;

  // Called by the AI streaming layer when a new message arrives
  addMessage: (msg: ChatMessage) => Promise<void>;
  updateLastAssistantMessage: (content: string) => void;
}

export const createChatSlice: StateCreator<AppStore, [], [], ChatSlice> = (set, get) => ({
  threads: [],
  activeThread: null,
  messages: [],

  loadThreads: async (workspaceId, projectId) => {
    const threads = await queries.getThreads(workspaceId, projectId);
    set({ threads });
  },

  selectThread: async (thread) => {
    set({ activeThread: thread, messages: [] });
    const messages = await queries.getMessages(thread.id);
    set({ messages });
  },

  createThread: async (workspaceId, projectId, title) => {
    const timestamp = now();
    const thread: ChatThread = {
      id: nanoid(),
      scope: projectId ? "project" : "workspace",
      workspaceId,
      projectId,
      title,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await queries.createThread(thread);
    set((state) => ({ threads: [thread, ...state.threads], activeThread: thread, messages: [] }));
    return thread;
  },

  clearActiveThread: () => set({ activeThread: null, messages: [] }),

  addMessage: async (msg) => {
    set((state) => ({ messages: [...state.messages, msg] }));
    await queries.createMessage(msg);
    const threadId = get().activeThread?.id;
    if (threadId) {
      await queries.updateThreadTimestamp(threadId, msg.createdAt);
    }
  },

  updateLastAssistantMessage: (content) => {
    set((state) => {
      const msgs = [...state.messages];
      const lastIdx = msgs.length - 1;
      if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
        msgs[lastIdx] = { ...msgs[lastIdx], content };
      }
      return { messages: msgs };
    });
  },
});
