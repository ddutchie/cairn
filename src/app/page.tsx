"use client";

import { useEffect, useState } from "react";
import { useCairnStore } from "@/store";
import { TitleBar } from "@/components/layout/title-bar";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { ProjectOverview } from "@/components/layout/project-overview";
import { NotesView } from "@/components/notes/notes-view";
import { KanbanBoard } from "@/components/kanban/board";
import { ChatPanel } from "@/components/chat/chat-panel";
import { SearchPanel } from "@/components/search/search-panel";
import { SettingsView } from "@/components/settings/settings-view";
import { CreateWorkspace } from "@/components/onboarding/create-workspace";

export default function Home() {
  const {
    hydrate,
    hydrateFromElectron,
    workspaces,
    activeView,
    chatOpen,
    searchOpen,
    toggleSearch,
    toggleChat,
  } = useCairnStore();

  // null = still loading, false = loaded with data, true = needs onboarding
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && window.electron) {
      // Kick off initial hydration
      hydrateFromElectron().then(() => {
        const ws = useCairnStore.getState().workspaces;
        setNeedsOnboarding(ws.length === 0);
      });

      // Register db:changed listener synchronously so React gets the cleanup fn
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const unsub = (window.electron as any).onDbChanged(() => {
        hydrateFromElectron(true);
      });
      return unsub;
    } else {
      hydrate();
      setNeedsOnboarding(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Global keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const { key, metaKey, ctrlKey } = e;
      const mod = metaKey || ctrlKey;
      if (mod && key === "k") { e.preventDefault(); toggleSearch(); }
      else if (mod && key === "/") { e.preventDefault(); toggleChat(); }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleSearch, toggleChat]);

  // Still loading
  if (needsOnboarding === null) {
    return (
      <main className="flex flex-col h-dvh w-screen overflow-hidden bg-[var(--background)]">
        <TitleBar />
        <div className="flex flex-1 items-center justify-center">
          <span className="text-xs text-[var(--text-tertiary)]">Loading…</span>
        </div>
      </main>
    );
  }

  // First run — no workspace yet
  if (needsOnboarding) {
    return (
      <main className="flex flex-col h-dvh w-screen overflow-hidden bg-[var(--background)]">
        <TitleBar />
        <div className="flex flex-1 min-h-0">
          <CreateWorkspace onComplete={() => setNeedsOnboarding(false)} />
        </div>
      </main>
    );
  }

  // Main app
  return (
    <main className="flex flex-col h-dvh w-screen overflow-hidden bg-[var(--background)]">
      {/* Electron title bar — draggable, clears macOS traffic lights */}
      <TitleBar />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left sidebar */}
        <Sidebar />

        {/* Main content area */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          <Topbar />
          <div className="flex flex-1 min-h-0 overflow-hidden">
            {activeView === "overview"  && <ProjectOverview />}
            {activeView === "notes"     && <NotesView />}
            {activeView === "board"     && <KanbanBoard />}
            {activeView === "settings"  && <SettingsView />}
          </div>
        </div>

        {/* AI Chat panel */}
        {chatOpen && <ChatPanel />}

        {/* Global search overlay */}
        {searchOpen && <SearchPanel />}
      </div>
    </main>
  );
}
