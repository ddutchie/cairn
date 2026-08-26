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
  const [popoutError, setPopoutError] = useState<string | null>(null);

  useEffect(() => {
    async function init() {
      if (window.electron?.chat.popoutReady) {
        const handedOff = await window.electron.chat.popoutReady() as unknown as Record<string, unknown> & { reason?: string };
        const bound = bindChatPopoutSession(handedOff);
        if (!bound) {
          const reason = typeof handedOff?.reason === "string" ? handedOff.reason : "";
          if (reason === "profile-mismatch") {
            setPopoutError("Session unavailable — profile mismatch");
          } else if (!handedOff || (handedOff as { sessionId?: string })?.sessionId === "") {
            setPopoutError("Session unavailable — no session was handed off");
          } else {
            setPopoutError("Session unavailable — profile mismatch or missing session");
          }
        }
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

  // Handle live session updates pushed from main when a second popOut arrives while the pop-out is already open (C2 fix)
  useEffect(() => {
    const electron = window.electron as unknown as { chat: { onChatSessionUpdated?: (cb: (p: unknown) => void) => (()=>void) } } | undefined;
    if (!electron?.chat.onChatSessionUpdated) return;
    const unsub = electron.chat.onChatSessionUpdated((payload: unknown) => {
      const bound = bindChatPopoutSession(payload);
      if (bound) {
        setSession(bound);
        setPopoutError(null);
        useCairnStore.setState({ activeProjectId: bound.activeProjectId, activeWorkspaceId: bound.workspaceId });
      } else {
        setPopoutError("Session unavailable — profile mismatch");
        setSession(null);
      }
    });
    return () => { (unsub as unknown as (()=>void) | undefined)?.(); };
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
      {ready && popoutError && !session && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-sm font-medium text-[var(--text-primary)]">{popoutError}</p>
          <p className="text-xs text-[var(--text-tertiary)]">Close this window and try again from the main window.</p>
          <button
            onClick={() => window.close()}
            className="px-3 py-1.5 rounded-md text-xs text-[var(--text-primary)] bg-[var(--surface-3)] hover:bg-[var(--surface-4)] transition-colors"
          >
            Close window
          </button>
        </div>
      )}
      {ready && session && <SessionPopoutView key={session.sessionId} {...session} onPopIn={handlePopIn} />}
      {notificationOpen && <NotificationCenter onClose={() => setNotificationOpen(false)} />}
    </main>
  );
}
