"use client";

import { useEffect, useState, useCallback } from "react";
import { useCairnStore } from "@/store";
import { SessionPopoutView } from "@/components/chat/SessionPopoutView";
import { bindChatPopoutSession } from "../../../shared/agent/chat-popout";

export default function ChatPopoutPage() {
  const [ready, setReady] = useState(false);

  const [session, setSession] = useState<{ sessionId: string; activeProjectId: string | null } | null>(null);

  useEffect(() => {
    async function init() {
      if (window.electron?.chat.popoutReady) {
        const handedOff = await window.electron.chat.popoutReady();
        setSession(bindChatPopoutSession(handedOff));
        // Load workspace/config context only. The popout transcript is loaded
        // by SessionPopoutView from the canonical session surface; do not run
        // the cold chat hydration path here.
        await useCairnStore.getState().hydrateFromElectron(true);
        const savedAiConfig = await window.electron.getAiSettings?.();
        if (savedAiConfig) {
          const currentAiConfig = useCairnStore.getState().aiConfig;
          useCairnStore.setState({ aiConfig: { ...currentAiConfig, ...savedAiConfig } });
        }
        useCairnStore.setState({ activeProjectId: handedOff.activeProjectId });
      }

      setReady(true);
    }
    init();
  }, []);

  const handlePopIn = useCallback(async () => {
    if (session?.sessionId) await window.electron?.chat.popIn({ sessionId: session.sessionId });
  }, [session]);

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
      {ready && session && <SessionPopoutView sessionId={session.sessionId} activeProjectId={session.activeProjectId} onPopIn={handlePopIn} />}
    </main>
  );
}
