"use client";

import { useEffect, useState, useCallback } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { SessionPopoutView } from "@/components/chat/SessionPopoutView";
import { TitleBar } from "@/components/layout/title-bar";
import { NotificationCenter } from "@/components/automations/notification-center";
import { bindChatPopoutSession } from "../../../shared/agent/chat-popout";

export default function ChatPopoutPage() {
  const [ready, setReady] = useState(false);
  const { notificationOpen, setNotificationOpen, startNotificationPolling, stopNotificationPolling, startRunCountPolling, stopRunCountPolling } = useCairnStore(useShallow((s) => ({
    notificationOpen: s.notificationOpen,
    setNotificationOpen: s.setNotificationOpen,
    startNotificationPolling: s.startNotificationPolling,
    stopNotificationPolling: s.stopNotificationPolling,
    startRunCountPolling: s.startRunCountPolling,
    stopRunCountPolling: s.stopRunCountPolling,
  })));

  const [session, setSession] = useState<ReturnType<typeof bindChatPopoutSession>>(null);

  useEffect(() => {
    async function init() {
      if (window.electron?.chat.popoutReady) {
        const handedOff = await window.electron.chat.popoutReady();
        const bound = bindChatPopoutSession(handedOff);
        setSession(bound);
        // Load workspace/config context only. The popout transcript is loaded
        // by SessionPopoutView from the canonical session surface; do not run
        // the cold chat hydration path here.
        await useCairnStore.getState().hydrateFromElectron(true);
        const savedAiConfig = await window.electron.getAiSettings?.();
        if (savedAiConfig) {
          const currentAiConfig = useCairnStore.getState().aiConfig;
          useCairnStore.setState({ aiConfig: { ...currentAiConfig, ...savedAiConfig } });
        }
        if (bound) useCairnStore.setState({ activeProjectId: bound.activeProjectId, activeWorkspaceId: bound.workspaceId });
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

  // The popout has its own renderer/store instance, so it must start the same
  // feeds that drive the shared title-bar badges in the main window.
  useEffect(() => {
    startRunCountPolling();
    if (window.electron?.notification) startNotificationPolling();
    return () => {
      stopRunCountPolling();
      stopNotificationPolling();
    };
  }, [startNotificationPolling, stopNotificationPolling, startRunCountPolling, stopRunCountPolling]);

  return (
    <main className="flex flex-col h-dvh w-screen overflow-hidden bg-[var(--background)]">
      <TitleBar />
      {ready && session && <SessionPopoutView {...session} onPopIn={handlePopIn} />}
      {notificationOpen && <NotificationCenter onClose={() => setNotificationOpen(false)} />}
    </main>
  );
}
