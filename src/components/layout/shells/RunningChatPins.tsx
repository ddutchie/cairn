"use client";

import React, { useMemo } from "react";
import { MessageSquareText } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { useSessionRunningIds } from "@/hooks/useSessionRunningIds";
import type { ChatThread } from "@/types";

export interface PinnedChatThread {
  thread: ChatThread;
  running: boolean;
  unread: boolean;
  title: string;
}

/**
 * Threads worth pinning: a turn is live, or unseen output landed while another
 * thread was open — from any workspace. Lets the user jump back to the right
 * workspace + project + thread in one click.
 */
export function usePinnedChatThreads(): PinnedChatThread[] {
  const runningIds = useSessionRunningIds(true);
  const { chatThreads, chatMessages, unreadThreadIds, projectedTitles, activeChatThreadId } = useCairnStore(
    useShallow((s) => ({
      chatThreads: s.chatThreads,
      chatMessages: s.chatMessages,
      unreadThreadIds: s.unreadThreadIds ?? [],
      projectedTitles: s.projectedTitles,
      activeChatThreadId: s.activeChatThreadId,
    })),
  );

  return useMemo(() => {
    const running = new Set<string>();
    for (const sid of runningIds) {
      if (sid.startsWith("chat-")) running.add(sid.slice("chat-".length));
    }
    const wanted = new Set<string>([...running, ...unreadThreadIds]);
    wanted.delete(activeChatThreadId ?? "");
    const titleFor = (t: ChatThread): string =>
      projectedTitles[t.id] ?? t.title ??
      chatMessages.find((m) => m.threadId === t.id && m.role === "user")?.content.slice(0, 48) ??
      "New chat";
    return chatThreads
      .filter((t) => wanted.has(t.id))
      .map((t) => ({ thread: t, running: running.has(t.id), unread: unreadThreadIds.includes(t.id), title: titleFor(t) }))
      .sort((a, b) => {
        if (a.running !== b.running) return a.running ? -1 : 1;
        return new Date(b.thread.updatedAt).getTime() - new Date(a.thread.updatedAt).getTime();
      })
      .slice(0, 6);
  }, [runningIds, chatThreads, chatMessages, unreadThreadIds, projectedTitles, activeChatThreadId]);
}

export function RunningChatPins() {
  const pins = usePinnedChatThreads();
  const { workspaces, projects, activeWorkspaceId, setActiveWorkspace, setActiveProject, setActiveChatThreadId, chatOpen, toggleChat } =
    useCairnStore(
      useShallow((s) => ({
        workspaces: s.workspaces,
        projects: s.projects,
        activeWorkspaceId: s.activeWorkspaceId,
        setActiveWorkspace: s.setActiveWorkspace,
        setActiveProject: s.setActiveProject,
        setActiveChatThreadId: s.setActiveChatThreadId,
        chatOpen: s.chatOpen,
        toggleChat: s.toggleChat,
      })),
    );

  if (pins.length === 0) return null;

  const jump = (thread: ChatThread) => {
    // Set scope + thread atomically: the chat panel's thread-selection effect
    // preserves an explicit selection that is already in scope, so no
    // sequencing (rAF/timeout) is needed and it can't snap to another thread.
    if (thread.workspaceId !== activeWorkspaceId) setActiveWorkspace(thread.workspaceId);
    setActiveProject(thread.projectId ?? null);
    setActiveChatThreadId(thread.id);
    if (!chatOpen) toggleChat();
  };

  return (
    <div className="px-2 pb-1.5 space-y-0.5">
      <p className="px-2 pt-1 text-[0.571rem] font-semibold tracking-[0.08em] uppercase text-[var(--text-tertiary)]">
        Live chats
      </p>
      {pins.map(({ thread, running, unread, title }) => {
        const workspace = workspaces.find((w) => w.id === thread.workspaceId);
        const project = projects.find((p) => p.id === thread.projectId);
        const scope = [workspace?.name, project?.name].filter(Boolean).join(" / ");
        return (
          <button
            key={thread.id}
            onClick={() => jump(thread)}
            title={scope ? `${title} — ${scope}` : title}
            className="flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors text-left"
          >
            {running ? (
              <Spinner size={11} className="shrink-0 text-[var(--accent)]" />
            ) : (
              <MessageSquareText size={13} className="shrink-0 text-[var(--text-tertiary)]" />
            )}
            <span className="flex-1 min-w-0">
              <span className="block truncate">{title}</span>
              {scope && <span className="block truncate text-[0.643rem] text-[var(--text-tertiary)]">{scope}</span>}
            </span>
            {unread && !running && (
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0" aria-label="Unread replies" />
            )}
          </button>
        );
      })}
      <div className="my-1.5 border-t border-[var(--border-subtle)]" />
    </div>
  );
}
