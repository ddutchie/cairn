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
import { unwrapSessionPayload } from "@/components/conversation/conversation-session";

// ── Slice interface ───────────────────────────────────────────────────────────

export interface ChatSlice {
  chatThreads: ChatThread[];
  chatMessages: ChatMessage[];
  activeChatThreadId: string | null;
  /** Projected titles from dsh's session/title fold (null = no title yet). Chat-only. */
  projectedTitles: Record<string, string | null>;

  getOrCreateThread: (workspaceId: ID, projectId?: ID) => ChatThread;
  setActiveChatThreadId: (threadId: string | null) => void;
  loadChatFromDb: (workspaceId: ID) => Promise<void>;
  setProjectedTitle: (threadId: string, title: string | null) => void;
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
    stats?: ChatMessage["stats"],
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
  projectedTitles: {},

  setProjectedTitle(threadId, title) {
    set((s) => ({ projectedTitles: { ...s.projectedTitles, [threadId]: title } }));
  },

  setActiveChatThreadId(threadId) {
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
    const threadsRes = await ipcAwaitResult<ChatThread[]>(
      (e) => e.chat.threads(workspaceId) as Promise<{ data: ChatThread[] } | { error: string }>
    );
    // ipcAwaitResult returns {data} on success, but handle both wrapped and raw array (defensive)
    let dbThreads: ChatThread[] = [];
    if (Array.isArray(threadsRes)) {
      dbThreads = threadsRes as unknown as ChatThread[];
    } else if (threadsRes && typeof threadsRes === "object" && "data" in threadsRes && Array.isArray((threadsRes as { data: unknown }).data)) {
      dbThreads = (threadsRes as { data: ChatThread[] }).data;
    } else {
      return;
    }

    // Pull messages for every thread in parallel — dsh's JSONL session log
    // (JsonlSessionPersistence, stable id `chat-<threadId>`) is the sole
    // source of truth. The pre-Cordis `chat_messages` SQLite table was
    // dropped in migration v49; there is no SQLite fallback. A thread that
    // has no session log yet (a brand-new thread whose first turn hasn't
    // been persisted) simply renders empty until the first assistant reply
    // is written — expected behaviour, not a fallback.
    const usageByThreadId = new Map<string, unknown>();
    const titleByThreadId = new Map<string, string | null>();
    const messageLists = await Promise.all(
      dbThreads.map(async (t) => {
        try {
          const sessRes = await ipcAwaitResult<unknown>(
             
            (e) => (e.chat as unknown as { sessionMessages: (id: string) => Promise<{ data: unknown } | { error: string }> }).sessionMessages(t.id)
          );
          // Shared unwrapper — see unwrapSessionPayload for why this used to be
          // open-coded here (and drifted from the other three call sites).
          const payload = unwrapSessionPayload(sessRes);
          const data: ChatMessage[] | null = payload.messages.length > 0 ? payload.messages as ChatMessage[] : null;
          const usage: unknown = payload.usage;
          const title = (payload as { title?: string | null }).title ?? null;
          if (title) titleByThreadId.set(t.id, title);

          if (usage) usageByThreadId.set(t.id, usage);
          if (data && data.length > 0) {
            return data;
          }
        } catch (e) { console.warn("[chat] sessionMessages failed", { threadId: t.id, error: String(e) }); }
        return [];
      })
    );
    const dbMessages = messageLists.flat();

    // A newer workspace switch may have superseded this (async) load while we
    // awaited IPC. If so, bail before touching state so a stale load can't
    // overwrite the current workspace's chat or active-thread pointer.
    if (get().activeWorkspaceId !== workspaceId) return;

    set((s) => {
      // Merge threads: take DB row + restored/cached lastUsage so the ContextRing
      // and token-usage gauge restore immediately on reload/restart.
      const memById = new Map(s.chatThreads.map((t) => [t.id, t]));
      const dbThreadIds = new Set(dbThreads.map((t) => t.id));
      const mergedThreads = [
        ...dbThreads.map((t) => {
          const mem = memById.get(t.id);
          const restoredUsage = usageByThreadId.get(t.id) as ChatThread["lastUsage"];
          const finalUsage = restoredUsage ?? mem?.lastUsage ?? t.lastUsage;
          return finalUsage ? { ...t, lastUsage: finalUsage } : t;
        }),
        ...s.chatThreads.filter((t) => !dbThreadIds.has(t.id)),
      ];
      // Merge projected titles (session/title fold) — authoritative auto-titles.
      const nextProjected: Record<string, string | null> = { ...s.projectedTitles };
      for (const [tid, title] of titleByThreadId) {
        if (title) nextProjected[tid] = title;
        else if (title === null) nextProjected[tid] = null;
      }

      // Merge messages: session (dsh) is the source of truth for all loaded
      // threads. Replace in-memory copies for those threads so stale optimistic
      // streaming bubbles (e.g. empty content + tools) do not duplicate
      // alongside replayed turns.
      //
      // Preservation guard for in-flight streams: if the in-memory transcript
      // for a loaded thread has MORE messages than the DB fold (meaning we
      // have a just-sent user message + optimistic assistant that haven't
      // been persisted yet — the classic workspace-switch-mid-stream race),
      // keep the in-memory copy. The session log is eventually consistent
      // via the next chat:done write, at which point a subsequent
      // loadChatFromDb will re-sync cleanly.
      const dbLoadedThreadIds = new Set(dbThreads.map((t) => t.id));
      const inMemoryByThread = new Map<string, typeof s.chatMessages>();
      for (const m of s.chatMessages) {
        const arr = inMemoryByThread.get(m.threadId) ?? [];
        arr.push(m);
        inMemoryByThread.set(m.threadId, arr);
      }
      const dbByThread = new Map<string, typeof dbMessages>();
      for (const m of dbMessages) {
        const arr = dbByThread.get(m.threadId) ?? [];
        arr.push(m);
        dbByThread.set(m.threadId, arr);
      }
      const preserveInMemory = new Set<string>();
      for (const tid of dbLoadedThreadIds) {
        const mem = inMemoryByThread.get(tid) ?? [];
        const db = dbByThread.get(tid) ?? [];
        // Heuristic: in-memory has strictly more messages AND the last one is
        // a user turn (typical mid-stream shape). If both hold, the load
        // predates the pending turn — keep memory.
        if (mem.length > db.length && mem[mem.length - 1]?.role === "user") {
          preserveInMemory.add(tid);
        }
      }
      const cleanDbMessages = dbMessages.filter(
        (m) => !preserveInMemory.has(m.threadId) &&
          !(m.role === "assistant" && !m.content?.trim() && !m.reasoning?.trim() && String(m.id).includes("-trailing"))
      );
      const mergedMessages = [
        ...cleanDbMessages,
        ...s.chatMessages.filter((m) => !dbLoadedThreadIds.has(m.threadId) || preserveInMemory.has(m.threadId)),
      ];

      return { chatThreads: mergedThreads, chatMessages: mergedMessages, projectedTitles: nextProjected };
    });

    get().persist();

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
    let toRestore: string | null = null;
    if (saved && get().chatThreads.some((t) => t.id === saved && t.workspaceId === workspaceId)) {
      const hasMessages = get().chatMessages.some((m) => m.threadId === saved);
      if (hasMessages) {
        toRestore = saved;
      } else {
        const candidates = get().chatThreads
          .filter((t) => t.workspaceId === workspaceId && get().chatMessages.some((m) => m.threadId === t.id))
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        if (candidates.length > 0) {
          toRestore = candidates[0].id;
        } else {
          toRestore = saved;
        }
      }
    }
    if (toRestore) {
      set({ activeChatThreadId: toRestore });
    }
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

  addMessage(threadId, role, content, contextRefs, toolCalls, actions, reasoning, images, subagents, reasoningSummary, reasoningItems, reasoningField, reasoningModel, stats) {
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
      stats: stats && (stats.ttftMs !== undefined || stats.tokensPerSecond !== undefined || stats.outputTokens !== undefined) ? stats : undefined,
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
    const wasActive = get().activeChatThreadId === threadId;
    const deletedThread = get().chatThreads.find((t) => t.id === threadId);
    // Abort any live loop for this thread before deleting — otherwise
    // PersistenceCoordinator stays "live" and the next prompt on a new
    // thread can race with the still-preparing old session (chat-Z... while live)
    try {
      window.electron?.session.abort(`chat-${threadId}`);
    } catch {}
    set((s) => {
      const { [threadId]: _omit, ...rest } = s.projectedTitles;
      return {
        chatThreads: s.chatThreads.filter((t) => t.id !== threadId),
        chatMessages: s.chatMessages.filter((m) => m.threadId !== threadId),
        projectedTitles: rest,
        ...(wasActive ? { activeChatThreadId: null } : {}),
      };
    });
    if (wasActive) {
      storage.delete(ACTIVE_CHAT_THREAD_KEY);
      // If other threads remain for the same scope, activate the most recent one
      if (deletedThread) {
        const remaining = get().chatThreads;
        const candidates = remaining
          .filter(
            (t) =>
              t.workspaceId === deletedThread.workspaceId &&
              (deletedThread.projectId ? t.projectId === deletedThread.projectId : !t.projectId),
          )
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        if (candidates.length > 0) {
          set({ activeChatThreadId: candidates[0].id });
          storage.set(ACTIVE_CHAT_THREAD_KEY, candidates[0].id);
        }
      }
    }
    get().persist();
    ipc((e) => e.chat.deleteThread(threadId));
  },

  renameThread(threadId, title) {
    const trimmed = title.trim();
    // Optimistic update — projected title wins immediately, and SQLite is
    // updated via the sessionTitle service (which pins kind:'user').
    set((s) => ({
      chatThreads: s.chatThreads.map((t) =>
        t.id === threadId ? { ...t, title: trimmed || undefined, updatedAt: now() } : t
      ),
      projectedTitles: { ...s.projectedTitles, [threadId]: trimmed || null },
    }));
    get().persist();
    // Pin via dsh's sessionTitle.rename (kind:'user' — stops auto-titling).
    // Chat-only: coding sessions are not auto-titled in phase 1.
    ipcAwait((e) => (e as unknown as { session: { renameTitle: (args: { threadId: string; title: string }) => Promise<unknown> } }).session.renameTitle({ threadId, title: trimmed }));
    // Also keep SQLite index row in sync (SQLite is the thread-list fallback).
    const thread = get().chatThreads.find((t) => t.id === threadId);
    if (thread) ipc((e) => e.chat.upsertThread({ ...thread, title: trimmed || undefined, updatedAt: now() }));
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
            apiMode: aiConfig.savedProviders?.find((p) => p.id === aiConfig.activeProviderId)?.apiMode ?? "completions",
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
        const sessRes = await ipcAwaitResult<unknown>(
           
          (e) => (e.chat as unknown as { sessionMessages: (id: string) => Promise<{ data: unknown } | { error: string }> }).sessionMessages(threadId)
        );
        let fresh: ChatMessage[] = [];
        let usage: unknown = undefined;
        let raw: unknown = sessRes;
        if (raw && typeof raw === "object" && "data" in raw && (raw as { data: unknown }).data !== undefined) {
          raw = (raw as { data: unknown }).data;
        }
        if (Array.isArray(raw)) {
          fresh = raw as ChatMessage[];
        } else if (raw && typeof raw === "object" && "messages" in raw && Array.isArray((raw as { messages?: unknown }).messages)) {
          fresh = (raw as { messages: ChatMessage[] }).messages;
          usage = (raw as { usage?: unknown }).usage;
        }


        set((s) => ({
          chatMessages: [...s.chatMessages.filter((m) => m.threadId !== threadId), ...fresh],
          chatThreads: s.chatThreads.map((t) => (t.id === threadId ? { ...t, lastUsage: (usage as ChatThread["lastUsage"]) ?? t.lastUsage, updatedAt: now() } : t)),
        }));
        get().persist();
      } catch (err) {
        console.warn("[chat] compact reload failed", err);
      }
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

  async clearAllThreads(workspaceId, projectId) {
    const toDelete = get().chatThreads.filter(
      (t) => t.workspaceId === workspaceId && (projectId ? t.projectId === projectId : true)
    );
    const ids = new Set(toDelete.map((t) => t.id));
    set((s) => {
      const nextTitles: Record<string, string | null> = { ...s.projectedTitles };
      for (const id of ids) delete nextTitles[id];
      return {
        chatThreads: s.chatThreads.filter((t) => !ids.has(t.id)),
        chatMessages: s.chatMessages.filter((m) => !ids.has(m.threadId)),
        projectedTitles: nextTitles,
        activeChatThreadId: ids.has(s.activeChatThreadId ?? "") ? null : s.activeChatThreadId,
      };
    });
    get().persist();
    // Clear last-active pointer if it was one of the deleted threads
    if (ids.has(storage.get<string>(ACTIVE_CHAT_THREAD_KEY) ?? "")) {
      storage.delete(ACTIVE_CHAT_THREAD_KEY);
    }
    await ipcAwait((e) => e.chat.clearAllThreads(workspaceId, projectId ?? undefined));
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
