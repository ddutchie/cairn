"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Download, X, AlertCircle } from "lucide-react";
import { useCairnStore } from "@/store";
import { CairnEvents } from "@/lib/events";
import { historyManager, ownWriteGuard } from "@/lib/history";

// ── IPC error toast ───────────────────────────────────────────────────────────

interface ErrorToast {
  id: number;
  message: string;
}

let _toastSeq = 0;

function useIpcErrorToasts() {
  const [toasts, setToasts] = useState<ErrorToast[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    function onIpcError(e: Event) {
      const message = (e as CustomEvent<{ message: string }>).detail.message;
      const id = ++_toastSeq;
      setToasts((prev) => [...prev.slice(-4), { id, message }]); // keep at most 5
      timers.current.set(id, setTimeout(() => dismiss(id), 5000));
    }
    window.addEventListener("cairn:ipc-error", onIpcError);
    return () => window.removeEventListener("cairn:ipc-error", onIpcError);
  }, [dismiss]);

  return { toasts, dismiss };
}
import { TitleBar } from "@/components/layout/title-bar";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { ProjectOverview } from "@/components/layout/project-overview";
import { NotesView } from "@/components/notes/notes-view";
import { KanbanBoard } from "@/components/kanban/board";
import { IdeaFlowView } from "@/components/flow/flow-view";
import { KnowledgeGraphView } from "@/components/graph/KnowledgeGraphView";
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
    toggleSidebar,
    setView,
    createNote,
    activeProjectId,
  } = useCairnStore();

  // null = still loading
  // "workspace" = needs workspace folder setup (existing or new user)
  // "create" = has workspace folder but no workspace record yet
  // false = fully set up
  const [onboardingState, setOnboardingState] = useState<"workspace" | "create" | false | null>(null);

  // Auto-updater state — tracked separately so event order doesn't matter
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updateDownloaded, setUpdateDownloaded] = useState(false);

  // Chat pre-fill — set by cairn:open-chat event (e.g. from "Fix with AI" button)
  const [chatPrefill, setChatPrefill] = useState<string | null>(null);

  // IPC error toasts
  const { toasts, dismiss } = useIpcErrorToasts();

  useEffect(() => {
    const electron = window.electron;
    if (typeof window !== "undefined" && electron) {
      Promise.all([
        electron.needsWorkspaceSetup(),
        hydrateFromElectron(),
      ]).then(([needsSetup]) => {
        if (needsSetup) {
          setOnboardingState("workspace");
        } else {
          const ws = useCairnStore.getState().workspaces;
          setOnboardingState(ws.length === 0 ? "create" : false);
        }
      });

      // Register db:changed listener synchronously so React gets the cleanup fn
      const unsubDb = electron.onDbChanged(() => {
        // Don't clear history if the change came from our own write (store ipc or flow canvas).
        if (ownWriteGuard.isOwnWrite()) {
          void hydrateFromElectron(false);
        } else {
          hydrateFromElectron(true);
        }
      });

      // Auto-updater listeners — events may arrive in any order
      const unsubAvailable = electron.updater.onUpdateAvailable((info) => {
        setUpdateVersion(info.version);
      });
      const unsubDownloaded = electron.updater.onUpdateDownloaded(() => {
        setUpdateDownloaded(true);
      });

      return () => {
        unsubDb();
        unsubAvailable();
        unsubDownloaded();
      };
    } else {
      hydrate();
      setOnboardingState(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Global keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const { key, metaKey, ctrlKey } = e;
      const mod = metaKey || ctrlKey;
      // Skip if focus is inside an input/textarea/contenteditable
      const tag = (e.target as HTMLElement)?.tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable;

      if (mod && key === "k") { e.preventDefault(); toggleSearch(); }
      else if (mod && key === "/") { e.preventDefault(); toggleChat(); }
      else if (mod && key === "\\") { e.preventDefault(); toggleSidebar(); }
      else if (mod && key === "1") { e.preventDefault(); setView("overview"); }
      else if (mod && key === "2") { e.preventDefault(); setView("notes"); }
      else if (mod && key === "3") { e.preventDefault(); setView("board"); }
      else if (mod && key === "4") { e.preventDefault(); setView("flow"); }
      else if (mod && key === "5") { e.preventDefault(); setView("graph"); }
      else if (mod && key === "n" && !inInput) {
        e.preventDefault();
        if (activeProjectId) {
          setView("notes");
          // Dispatch a custom event that NotesView listens for to create a note
          window.dispatchEvent(CairnEvents.newNote());
        }
      }
      // Undo / Redo — only when focus is NOT inside a text input or editor
      // (those surfaces handle ⌘Z natively via the browser / CodeMirror)
      else if (mod && key === "z" && !e.shiftKey && !inInput) {
        e.preventDefault();
        void historyManager.undo();
      }
      else if (mod && (key === "y" || (key === "z" && e.shiftKey)) && !inInput) {
        e.preventDefault();
        void historyManager.redo();
      }
    }
    function handleOpenChat(e: Event) {
      const { prefill } = (e as CustomEvent<{ prefill: string }>).detail;
      setChatPrefill(prefill);
      if (!chatOpen) toggleChat();
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("cairn:open-chat", handleOpenChat);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("cairn:open-chat", handleOpenChat);
    };
  }, [toggleSearch, toggleChat, toggleSidebar, setView, activeProjectId, createNote]);

  // Still loading
  if (onboardingState === null) {
    return (
      <main className="flex flex-col h-dvh w-screen overflow-hidden bg-[var(--background)]">
        <TitleBar />
        <div className="flex flex-1 items-center justify-center">
          <span className="text-xs text-[var(--text-tertiary)]">Loading…</span>
        </div>
      </main>
    );
  }

  // Needs workspace folder setup (migration prompt or new user folder pick)
  // OR needs workspace record created after folder is chosen
  if (onboardingState === "workspace" || onboardingState === "create") {
    return (
      <main className="flex flex-col h-dvh w-screen overflow-hidden bg-[var(--background)]">
        <TitleBar />
        <div className="flex flex-1 min-h-0">
          <CreateWorkspace
            initialStep={onboardingState === "workspace" ? "choose-folder" : "workspace-details"}
            onComplete={() => setOnboardingState(false)}
          />
        </div>
      </main>
    );
  }

  // Main app
  return (
    <main className="flex flex-col h-dvh w-screen overflow-hidden bg-[var(--background)]">
      {/* Electron title bar — draggable, clears macOS traffic lights */}
      <TitleBar />

      {/* Auto-update banner — shown as soon as we know a version is available or downloaded */}
      {(updateVersion || updateDownloaded) && (
        <div className="flex items-center gap-3 px-4 py-2 bg-[var(--accent-dim)] border-b border-[var(--accent)]/30 flex-shrink-0">
          <Download size={13} className="text-[var(--accent)] shrink-0" />
          <span className="text-xs text-[var(--text-secondary)] flex-1">
            {updateDownloaded
              ? <>Cairn <strong className="text-[var(--text-primary)]">v{updateVersion}</strong> is ready to install.</>
              : <>Downloading Cairn <strong className="text-[var(--text-primary)]">v{updateVersion}</strong>…</>
            }
          </span>
          {updateDownloaded && (
            <button
              onClick={() => window.electron?.updater.install()}
              className="px-3 py-1 rounded-md text-xs font-medium bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
            >
              Restart &amp; install
            </button>
          )}
          <button
            onClick={() => { setUpdateVersion(null); setUpdateDownloaded(false); }}
            className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      )}

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
            {activeView === "flow"      && <IdeaFlowView />}
            {activeView === "graph"     && <KnowledgeGraphView />}
            {activeView === "settings"  && <SettingsView />}
          </div>
        </div>

        {/* AI Chat panel */}
        {chatOpen && <ChatPanel prefill={chatPrefill} onPrefillConsumed={() => setChatPrefill(null)} />}

        {/* Global search overlay */}
        {searchOpen && <SearchPanel />}
      </div>

      {/* IPC error toasts — bottom-right, auto-dismiss after 5s */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className="flex items-start gap-2 px-3 py-2.5 rounded-lg border border-[var(--danger)]/30 bg-[var(--background)] shadow-lg max-w-xs pointer-events-auto"
            >
              <AlertCircle size={13} className="text-[var(--danger)] shrink-0 mt-0.5" />
              <span className="text-xs text-[var(--text-secondary)] flex-1 leading-relaxed">{toast.message}</span>
              <button
                onClick={() => dismiss(toast.id)}
                className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors shrink-0"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
