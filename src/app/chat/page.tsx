"use client";

import { useEffect, useState, useCallback } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { ChatPanel } from "@/components/chat/chat-panel";
import { chatSessionId, chatThreadId } from "../../../shared/agent/session-identity";

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
        if (state?.sessionId) {
          const threadId = chatThreadId(state.sessionId);
          setActiveChatThreadId(threadId);
          const workspaceId = useCairnStore.getState().activeWorkspaceId;
          if (workspaceId) await useCairnStore.getState().loadChatFromDb(workspaceId);
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
    const threadId = useCairnStore.getState().activeChatThreadId;
    if (threadId) await window.electron?.chat.popIn({ sessionId: chatSessionId(threadId) });
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
