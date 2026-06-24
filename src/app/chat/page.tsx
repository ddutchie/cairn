"use client";

import { useEffect, useState, useCallback } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { ChatThread, ChatMessage } from "@/types";
import { ChatPanel } from "@/components/chat/chat-panel";

export default function ChatPopoutPage() {
  const [ready, setReady] = useState(false);

  const { setActiveChatThreadId } = useCairnStore(useShallow((s) => ({
    setActiveChatThreadId: s.setActiveChatThreadId,
  })));

  useEffect(() => {
    async function init() {
      useCairnStore.getState().hydrate();

      if (window.electron?.chat.popoutReady) {
        const state = await window.electron.chat.popoutReady();
        if (state && state.chatThreads) {
          useCairnStore.setState({
            chatThreads: state.chatThreads as ChatThread[],
            chatMessages: state.chatMessages as ChatMessage[],
          });
        }
        if (state?.threadId) {
          setActiveChatThreadId(state.threadId);
        }
        if (state?.activeProjectId != null) {
          useCairnStore.setState({ activeProjectId: state.activeProjectId });
        }
      }

      setReady(true);
    }
    init();
  }, [setActiveChatThreadId]);

  const handlePopIn = useCallback(async () => {
    const state = useCairnStore.getState();
    await window.electron?.chat.popIn({
      threadId: state.activeChatThreadId as string | null,
      chatThreads: state.chatThreads as unknown[],
      chatMessages: state.chatMessages as unknown[],
      activeProjectId: state.activeProjectId as string | null,
    });
  }, []);

  // Listen for main window's "Pop in" request (relayed via main process)
  useEffect(() => {
    const electron = window.electron;
    if (!electron?.chat.onChatRequestPopIn) return;
    const unsub = electron.chat.onChatRequestPopIn(() => {
      handlePopIn();
    });
    return () => { unsub?.(); };
  }, [handlePopIn]);

  return (
    <main className="flex flex-col h-dvh w-screen overflow-hidden bg-[var(--background)]">
      {ready && <ChatPanel popoutMode />}
    </main>
  );
}
