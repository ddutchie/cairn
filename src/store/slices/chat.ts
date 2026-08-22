/**
 * Chat slice — threads and messages.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { ChatThread, ChatMessage, ChatToolCallRecord, ID, TokenBreakdown } from "@/types";
import { id, now } from "@/lib/utils";
import { storage } from "@/lib/storage";
import { ACTIVE_CHAT_THREAD_KEY } from "@/lib/constants";
import { ipc, ipcAwait, ipcAwaitResult } from "../ipc";

// ── Slice interface ───────────────────────────────────────────────────────────

export interface ChatSlice {
  chatThreads: ChatThread[];
  chatMessages: ChatMessage[];
  activeChatThreadId: string | null;

  getOrCreateThread: (workspaceId: ID, projectId?: ID) => ChatThread;
  setActiveChatThreadId: (threadId: string | null) => void;
  loadChatFromDb: (workspaceId: ID) => Promise<void>;
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
    reasoningSummary?: string,
    reasoningItems?: Array<Record<string, unknown>>,
    reasoningField?: string,
    reasoningModel?: string,
  ) => ChatMessage;
  deleteThread: (threadId: ID) => void;
  renameThread: (threadId: ID, title: string) => void;
  createNewThread: (workspaceId: ID, projectId?: ID) => ChatThread;
  compactChatThread: (threadId: ID) => Promise<void>;
  clearThreadMessages: (threadId: ID) => Promise<void>;
  clearAllThreads: (workspaceId: ID, projectId?: ID) => Promise<void>;
  setThreadUsage: (threadId: ID, usage: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    breakdown?: TokenBreakdown;
    costUsd?: number;
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
    console.log("[chat] setActiveChatThreadId", { threadId, prev: get().activeChatThreadId, stack: new Error().stack?.split("\n")[2]?.trim() });
    set({ activeChatThreadId: threadId });
    // Persist so the last-active thread is restored across restarts. SQLite is
    // the durable source of truth for the threads themselves (see loadChatFromDb);
    // this pointer just remembers which one to re-select.
    if (threadId) storage.set(ACTIVE_CHAT_THREAD_KEY, threadId);
    else storage.delete(ACTIVE_CHAT_THREAD_KEY);
  },

  /**
   * Load chat threads (and their messages) from SQLite into the store, then
   * restore the last-active thread pointer. SQLite — not localStorage — is the
   * durable store: an app update can clear/relocate Chromium localStorage, but
   * every thread + message is written to SQLite on create/send. This re-reads
   * them so conversations survive restarts and updates.
   *
   * Threads/messages already in memory (e.g. an in-flight message not yet
   * flushed, or a just-created empty thread) win over the DB copy so we never
   * clobber optimistic state.
   */
  async loadChatFromDb(workspaceId) {
    console.log("[chat] loadChatFromDb start", { workspaceId });
    const threadsRes = await ipcAwaitResult<ChatThread[]>(
      (e) => e.chat.threads(workspaceId) as Promise<{ data: ChatThread[] } | { error: string }>
    );
    console.log("[chat] threadsRes", threadsRes);
    // ipcAwaitResult returns {data} on success, but handle both wrapped and raw array (defensive)
    let dbThreads: ChatThread[] = [];
    if (Array.isArray(threadsRes)) {
      dbThreads = threadsRes as unknown as ChatThread[];
    } else if (threadsRes && typeof threadsRes === "object" && "data" in threadsRes && Array.isArray((threadsRes as { data: unknown }).data)) {
      dbThreads = (threadsRes as { data: ChatThread[] }).data;
    } else {
      console.warn("[chat] no threads data", threadsRes);
      return;
    }
    console.log("[chat] dbThreads", dbThreads.map((t) => ({ id: t.id, ws: t.workspaceId, proj: t.projectId })) );

    // Pull messages for every thread in parallel — dsh session is the source of truth
    // (JsonlSessionPersistence `chat-<threadId>`), not the duplicated `chat_messages` SQLite
    // table (cairnSessionPlugin + useChatStream double-write). Falls back to SQLite for
    // legacy threads that have no session yet (pre-dsh).
    const messageLists = await Promise.all(
      dbThreads.map(async (t) => {
        try {
          const sessRes = await ipcAwaitResult<ChatMessage[]>(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (e) => (e.chat as unknown as { sessionMessages: (id: string) => Promise<{ data: ChatMessage[] } | { error: string }> }).sessionMessages(t.id) as Promise<{ data: ChatMessage[] } | { error: string }>
          );
          let data: ChatMessage[] | null = null;
          if (Array.isArray(sessRes)) data = sessRes as unknown as ChatMessage[];
          else if (sessRes && typeof sessRes === "object" && "data" in sessRes && Array.isArray((sessRes as { data: unknown }).data)) data = (sessRes as { data: ChatMessage[] }).data;
          if (data && data.length > 0) {
            console.log("[chat] sessionMessages", { threadId: t.id, count: data.length, sample: data.slice(0, 2).map((m) => ({ role: m.role, content: m.content.slice(0, 30), toolCalls: m.toolCalls?.length, subagents: m.subagents?.length })) });
            return data;
          }
          if (data) console.log("[chat] sessionMessages empty, fallback to SQLite", { threadId: t.id });
        } catch (e) { console.warn("[chat] sessionMessages failed, fallback", { threadId: t.id, error: String(e) }); }
        const res = await ipcAwaitResult<ChatMessage[]>(
          (e) => e.chat.messages(t.id) as Promise<{ data: ChatMessage[] } | { error: string }>
        );
        if (Array.isArray(res)) return res as unknown as ChatMessage[];
        if (res && typeof res === "object" && "data" in res && Array.isArray((res as { data: unknown }).data)) return (res as { data: ChatMessage[] }).data;
        return [];
      })
    );
    const dbMessages = messageLists.flat();

    // A newer workspace switch may have superseded this (async) load while we
    // awaited IPC. If so, bail before touching state so a stale load can't
    // overwrite the current workspace's chat or active-thread pointer.
    if (get().activeWorkspaceId !== workspaceId) return;

    set((s) => {
      // Merge threads: keep any in-memory thread not yet in the DB; otherwise
      // take the DB row (it's the persisted truth) — but carry over the
      // in-memory `lastUsage`, which chat_threads does not persist and would
      // otherwise be lost (blanking the live token-usage gauge).
      const memById = new Map(s.chatThreads.map((t) => [t.id, t]));
      const dbThreadIds = new Set(dbThreads.map((t) => t.id));
      const mergedThreads = [
        ...dbThreads.map((t) => {
          const mem = memById.get(t.id);
          return mem?.lastUsage ? { ...t, lastUsage: mem.lastUsage } : t;
        }),
        ...s.chatThreads.filter((t) => !dbThreadIds.has(t.id)),
      ];

      // Merge messages: session (dsh) is the truth; in-memory (localStorage) copies
      // that are already in the session (same thread+role+content) are dropped to
      // collapse the optimistic `addMessage` duplicate (user `hi` + assistant `Hi…`
      // added via ChatPanel/useChatStream and also in the JSONL as `user/message`/
      // `assistant/message`). Id-based dedupe alone keeps both because ids differ.
      const dbMsgIds = new Set(dbMessages.map((m) => m.id));
      const dbKeys = new Set(dbMessages.map((m) => `${m.threadId}:${m.role}:${(m.content ?? "").trim()}`));
      const mergedMessages = [
        ...dbMessages,
        ...s.chatMessages.filter((m) => !dbMsgIds.has(m.id) && !dbKeys.has(`${m.threadId}:${m.role}:${(m.content ?? "").trim()}`)),
      ];

      return { chatThreads: mergedThreads, chatMessages: mergedMessages };
    });
    get().persist();

    console.log("[chat] merged", { threads: get().chatThreads.map((t) => ({ id: t.id, ws: t.workspaceId, proj: t.projectId })), messages: get().chatMessages.length, workspaceId });
    // Prune blank demo threads (1515 → ~30) — keep active + recent with messages
    {
      const activeId = get().activeChatThreadId;
      const nowMs = Date.now();
      const blanks = get().chatThreads.filter(
        (t) =>
          t.workspaceId === workspaceId &&
          t.id !== activeId &&
          t.id !== storage.get<string>(ACTIVE_CHAT_THREAD_KEY) &&
          !get().chatMessages.some((m) => m.threadId === t.id) &&
          nowMs - new Date(t.updatedAt).getTime() > 5 * 60 * 1000
      );
      if (blanks.length > 20) {
        // Keep 5 most recent blanks as provisional rows, delete the rest
        const keep = new Set(blanks.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 5).map((t) => t.id));
        const toPrune = blanks.filter((t) => !keep.has(t.id));
        if (toPrune.length > 0) {
          console.log("[chat] pruning blanks", { totalBlanks: blanks.length, pruning: toPrune.length, sample: toPrune.slice(0, 3).map((t) => t.id) });
          const pruneIds = new Set(toPrune.map((t) => t.id));
          set((s) => ({ chatThreads: s.chatThreads.filter((t) => !pruneIds.has(t.id)) }));
          get().persist();
          for (const t of toPrune) ipc((e) => e.chat.deleteThread(t.id));
        }
      }
    }
    // Restore the last-active thread if it still exists AND belongs to the
    // workspace we just loaded; otherwise leave it for the UI's
    // getOrCreateThread to pick a scoped thread.
    // If the saved thread is empty (no messages) — as after the previous run
    // created Uhhn5V33xGuG with 0 filtered messages while 698 total exist — pick
    // the most-recent thread with messages instead so old chats actually mount.
    const saved = storage.get<string>(ACTIVE_CHAT_THREAD_KEY);
    console.log("[chat] restore check", { saved, has: saved ? get().chatThreads.some((t) => t.id === saved && t.workspaceId === workspaceId) : false, workspaceId, threads: get().chatThreads.map((t) => t.id) });
    let toRestore: string | null = null;
    if (saved && get().chatThreads.some((t) => t.id === saved && t.workspaceId === workspaceId)) {
      const hasMessages = get().chatMessages.some((m) => m.threadId === saved);
      console.log("[chat] saved hasMessages", { saved, hasMessages, totalForSaved: get().chatMessages.filter((m) => m.threadId === saved).length });
      if (hasMessages) {
        toRestore = saved;
      } else {
        const candidates = get().chatThreads
          .filter((t) => t.workspaceId === workspaceId && get().chatMessages.some((m) => m.threadId === t.id))
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        console.log("[chat] candidates with messages", candidates.map((t) => ({ id: t.id, updatedAt: t.updatedAt, msgCount: get().chatMessages.filter((m) => m.threadId === t.id).length })));
        if (candidates.length > 0) {
          toRestore = candidates[0].id;
          console.log("[chat] saved empty, restoring most recent with messages", toRestore);
        } else {
          toRestore = saved;
        }
      }
    }
    if (toRestore) {
      console.log("[chat] restoring activeChatThreadId", toRestore);
      set({ activeChatThreadId: toRestore });
    }
  },

  getOrCreateThread(workspaceId, projectId) {
    console.log("[chat] getOrCreateThread", { workspaceId, projectId, threads: get().chatThreads.filter((t) => t.workspaceId === workspaceId).map((t) => ({ id: t.id, proj: t.projectId, updatedAt: t.updatedAt })), activeThreadId: get().activeChatThreadId });
    const existing = get().chatThreads.find(
      (t) =>
        t.workspaceId === workspaceId &&
        (projectId ? t.projectId === projectId : !t.projectId)
    );
    console.log("[chat] getOrCreateThread existing", existing?.id ?? null);
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

  addMessage(threadId, role, content, contextRefs, toolCalls, actions, reasoning, images, subagents, reasoningSummary, reasoningItems, reasoningField, reasoningModel) {
    console.log("[chat] addMessage", { threadId, role, content: content.slice(0, 80), threadExists: get().chatThreads.some((t) => t.id === threadId), threads: get().chatThreads.map((t) => t.id) });
    const msg: ChatMessage = {
      id: id(),
      threadId,
      role,
      content,
      reasoning: reasoning || undefined,
      reasoningSummary: reasoningSummary || undefined,
      reasoningItems: reasoningItems && reasoningItems.length > 0 ? reasoningItems : undefined,
      reasoningField: reasoningField || undefined,
      reasoningModel: reasoningModel || undefined,
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
    // Chat transcripts are persisted by dsh's JSONL session log (session-as-truth,
    // read back via db:chat:sessionMessages), NOT the chat_messages SQLite table.
    // We keep the message in memory (optimistic render for the live turn +
    // localStorage via persist()), but no longer write it to SQLite — that table
    // is legacy and was the source of the duplicate/ghost bubbles. Only the thread
    // index row is still upserted so the thread list can enumerate sessions.
    const thread = get().chatThreads.find((t) => t.id === threadId);
    if (thread) ipc((e) => e.chat.upsertThread({ ...thread, updatedAt: now() }));
    return msg;
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

    // Session-as-truth compaction: the electron handler runs dsh's compactNow,
    // which rewrites the thread's dsh session surface (a summary `replace` node).
    // We then re-read the thread from the session log so the compacted history
    // (summary node + retained tail) replaces the in-memory transcript.
    const result = await ipcAwaitResult<{ compacted: boolean }>(async (e) => {
      try {
        const obj = await e.chat.compactThread({
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          threadId,
          config: {
            provider: aiConfig.provider,
            baseUrl: aiConfig.baseUrl,
            model: aiConfig.model,
            apiKey: aiConfig.apiKey,
          },
        }) as { compacted: boolean };
        return { data: obj };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    });

    // Drop the "Compacting…" placeholder regardless of outcome.
    set((s) => ({ chatMessages: s.chatMessages.filter((m) => m.id !== tempId) }));

    if (result && "data" in result) {
      // Reload this thread's messages from the (now compacted) dsh session log so
      // the summary node + retained tail render, and the thread persists across
      // reload (session is the source of truth). Replace only THIS thread's
      // messages to avoid disturbing other threads' in-memory state.
      try {
        const sessRes = await ipcAwaitResult<ChatMessage[]>(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (e) => (e.chat as unknown as { sessionMessages: (id: string) => Promise<{ data: ChatMessage[] } | { error: string }> }).sessionMessages(threadId) as Promise<{ data: ChatMessage[] } | { error: string }>
        );
        let fresh: ChatMessage[] = [];
        if (Array.isArray(sessRes)) fresh = sessRes as unknown as ChatMessage[];
        else if (sessRes && typeof sessRes === "object" && "data" in sessRes && Array.isArray((sessRes as { data: unknown }).data)) fresh = (sessRes as { data: ChatMessage[] }).data;
        set((s) => ({
          chatMessages: [...s.chatMessages.filter((m) => m.threadId !== threadId), ...fresh],
          chatThreads: s.chatThreads.map((t) => (t.id === threadId ? { ...t, lastUsage: undefined, updatedAt: now() } : t)),
        }));
        get().persist();
      } catch (err) {
        console.warn("[chat] compact reload failed", err);
      }
    }
  },

  async clearThreadMessages(threadId) {
    console.log("[chat] clearThreadMessages", { threadId, beforeMessages: get().chatMessages.filter((m) => m.threadId === threadId).length, threads: get().chatThreads.map((t) => t.id) });
    set((s) => ({
      chatMessages: s.chatMessages.filter((m) => m.threadId !== threadId),
      chatThreads: s.chatThreads.map((t) =>
        t.id === threadId ? { ...t, lastUsage: undefined, updatedAt: now() } : t
      ),
    }));
    get().persist();
    await ipcAwait((e) => e.chat.clearThreadMessages(threadId));
    console.log("[chat] after clear", { threadId, remainingMessages: get().chatMessages.filter((m) => m.threadId === threadId).length, activeThreadId: get().activeChatThreadId });
  },

  async clearAllThreads(workspaceId, projectId) {
    const toDelete = get().chatThreads.filter(
      (t) => t.workspaceId === workspaceId && (projectId ? t.projectId === projectId : true)
    );
    console.log("[chat] clearAllThreads", { workspaceId, projectId, count: toDelete.length, ids: toDelete.map((t) => t.id).slice(0, 5) });
    const ids = new Set(toDelete.map((t) => t.id));
    set((s) => ({
      chatThreads: s.chatThreads.filter((t) => !ids.has(t.id)),
      chatMessages: s.chatMessages.filter((m) => !ids.has(m.threadId)),
      activeChatThreadId: ids.has(s.activeChatThreadId ?? "") ? null : s.activeChatThreadId,
    }));
    get().persist();
    // Clear last-active pointer if it was one of the deleted threads
    if (ids.has(storage.get<string>(ACTIVE_CHAT_THREAD_KEY) ?? "")) {
      storage.delete(ACTIVE_CHAT_THREAD_KEY);
    }
    await ipcAwait((e) => e.chat.clearAllThreads(workspaceId, projectId ?? undefined));
    console.log("[chat] after clearAll", { remainingThreads: get().chatThreads.length, remainingMessages: get().chatMessages.length });
    // Create a fresh empty thread so the panel doesn't stay in a null-thread state
    if (workspaceId) {
      const next = get().getOrCreateThread(workspaceId, projectId);
      set({ activeChatThreadId: next.id });
      storage.set(ACTIVE_CHAT_THREAD_KEY, next.id);
    }
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
