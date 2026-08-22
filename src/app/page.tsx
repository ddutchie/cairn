"use client";

import React, { useEffect, useState, useRef } from "react";
import { useCairnStore } from "@/store";
import { fetchAndCacheCommunityChatThemes } from "@/store/slices/ui";
import { useShallow } from "zustand/react/shallow";
import { CairnEvents } from "@/lib/events";
import { historyManager, ownWriteGuard } from "@/lib/history";
import { markAiNoteWriteStarted, markAiNoteWriteEnded, hasRecentAiNoteWrite } from "@/store/ipc";
import { useIpcErrorToasts } from "@/hooks/useIpcErrorToasts";
import { AppOverlayLayer, AppStatusBar } from "@/lib/plugin-ui/SlotOutlet";
import { startUIPlugins } from "@/lib/plugin-ui/loader";
import { TitleBar } from "@/components/layout/title-bar";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { ProjectOverview } from "@/components/layout/project-overview";
import { NotesView } from "@/components/notes/notes-view";
import { KanbanBoard } from "@/components/kanban/board";
import { CalendarView } from "@/components/calendar/CalendarView";
import { IdeaFlowView } from "@/components/flow/flow-view";
import { KnowledgeGraphView } from "@/components/graph/KnowledgeGraphView";
import { InsightsView } from "@/components/insights/InsightsView";
import { SearchPanel } from "@/components/search/search-panel";
import { SettingsView } from "@/components/settings/settings-view";
import { AutomationsView } from "@/components/automations/automations-view";
import { UsageView } from "@/components/usage/UsageView";
import { NotificationCenter } from "@/components/automations/notification-center";
import { AgentView } from "@/components/agent/AgentView";
import { Onboarding } from "@/components/onboarding";
import { UnifiedChatPanel } from "@/components/chat/UnifiedChatPanel";
import { UpdateBanner, ErrorToasts } from "@/components/layout/app-chrome";
import { ConflictBanner } from "@/components/layout/conflict-banner";
import { ConflictResolutionModal } from "@/components/layout/conflict-resolution-modal";
import { useSyncStatus, useConflictModalOpen, closeConflictModal } from "@/lib/sync-client";
import { NewFeatureModal } from "@/components/layout/NewFeatureModal";
import { AppTutorial } from "@/components/tutorial/AppTutorial";
import { cn } from "@/lib/utils";
import { NEW_FEATURES_REGISTRY } from "@/lib/new-features-registry";
import { completeOnboarding } from "@/lib/complete-onboarding";

export default function Home() {
  const [pendingTutorial, setPendingTutorial] = useState(false);

  const handleNewFeatureModalClose = () => {
    if (pendingTutorial) {
      setPendingTutorial(false);
      useCairnStore.getState().setTutorialActive(true);
    }
  };
  const {
    hydrate,
    hydrateFromElectron,
    activeView,
    chatOpen,
    searchOpen,
    toggleSearch,
    toggleChat,
    toggleSidebar,
    setView,
    createNote,
    activeProjectId,
    hiddenViews,
    chatPanelWidth,
    chatPanelResizing,
    lastContentView,
    startNotificationPolling,
    stopNotificationPolling,
    notificationOpen,
    setNotificationOpen,
    runningAutomationCount,
    startRunCountPolling,
    stopRunCountPolling,
  } = useCairnStore(useShallow((s) => ({
    hydrate:             s.hydrate,
    hydrateFromElectron: s.hydrateFromElectron,
    activeView:          s.activeView,
    chatOpen:            s.chatOpen,
    searchOpen:          s.searchOpen,
    toggleSearch:        s.toggleSearch,
    toggleChat:          s.toggleChat,
    toggleSidebar:       s.toggleSidebar,
    setView:             s.setView,
    createNote:          s.createNote,
    activeProjectId:     s.activeProjectId,
    hiddenViews:         s.hiddenViews,
    chatPanelWidth:      s.chatPanelWidth,
    chatPanelResizing:   s.chatPanelResizing,
    lastContentView:     s.lastContentView,
    startNotificationPolling: s.startNotificationPolling,
    stopNotificationPolling:  s.stopNotificationPolling,
    notificationOpen:    s.notificationOpen,
    setNotificationOpen: s.setNotificationOpen,
    runningAutomationCount: s.runningAutomationCount,
    startRunCountPolling: s.startRunCountPolling,
    stopRunCountPolling:  s.stopRunCountPolling,
  })));
  // All navigable views in shortcut order; overview=⌘1, notes=⌘2, then visible extras
  const ORDERED_VIEWS = (["board", "calendar", "flow", "agent", "calendar-all", "graph", "insights", "automations", "usage"] as const).filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (v) => !hiddenViews.has(v as any)
  );

  // null = still loading
  // "workspace" = needs workspace folder setup (existing or new user)
  // "create" = has workspace folder but no workspace record yet
  // "dev" = dev shortcut — skip workspace steps, start at appearance
  // false = fully set up
  const [onboardingState, setOnboardingState] = useState<"workspace" | "create" | "dev" | false | null>(null);
  // Ref so the db:changed closure can read the current value without a stale capture
  const onboardingStateRef = useRef<"workspace" | "create" | "dev" | false | null>(null);
  // Keep ref in sync whenever state changes
  useEffect(() => { onboardingStateRef.current = onboardingState; }, [onboardingState]);

  // Start the UI-plugin loader once (dev-gated in main; no-op otherwise). Pulls
  // renderer-side plugin sources from <userData>/plugins and activates them into
  // Cairn's plugin-UI slots (app.overlay, statusbar, …), live-reloading on change.
  useEffect(() => { startUIPlugins(); }, []);

  // Expose the chat panel width as a :root CSS variable so the fixed chat panel
  // and the centered content margin share one live source. The drag writes the
  // variable imperatively (no React re-renders per mousemove); this effect keeps
  // it in sync with the committed store value.
  useEffect(() => {
    if (typeof window === "undefined") return;
    document.documentElement.style.setProperty("--chat-panel-width", `${chatPanelWidth}px`);
  }, [chatPanelWidth]);

  // Auto-updater state — tracked separately so event order doesn't matter
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updateDownloaded, setUpdateDownloaded] = useState(false);

  // Live sync status (for the conflict banner + resolution modal chrome).
  const { conflicts: syncConflicts } = useSyncStatus();
  const conflictModalOpen = useConflictModalOpen();

  // Chat pre-fill — set by cairn:open-chat event (e.g. from "Fix with AI" button)
  const [chatPrefill, setChatPrefill] = useState<{ text: string; autoSend?: boolean } | null>(null);

  // IPC error toasts
  const { toasts, dismiss } = useIpcErrorToasts();

  // Expose the Zustand store on window for E2E automation (Playwright reads
  // window.__cairnStore — see tests/e2e/smoke.test.ts). Harmless read-only
  // handle; only used to drive navigation in tests.
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as unknown as { __cairnStoreRef?: typeof useCairnStore }).__cairnStoreRef = useCairnStore;
  }, []);

  // Live running-automation polling for the sidebar badge. Lightweight:
  // surfaces without a full renderer reload.
  useEffect(() => {
    if (typeof window === "undefined") return;
    startRunCountPolling();
    return () => stopRunCountPolling();
  }, [startRunCountPolling, stopRunCountPolling]);

  // Live unread-notification polling for the bell badge + center (same pattern;
  // also subscribes to the main-process mcp:unread-count pushes).
  useEffect(() => {
    if (typeof window === "undefined" || !window.electron?.notification) return;
    startNotificationPolling();
    return () => stopNotificationPolling();
  }, [startNotificationPolling, stopNotificationPolling]);

  // Fetch + cache the community chat-themes catalog at boot so a stored
  // community theme id applies immediately (it otherwise falls back to the
  // default until a theme picker mounts). Soft-fails; the pickers refresh on
  // open too.
  useEffect(() => {
    void fetchAndCacheCommunityChatThemes();
  }, []);

  useEffect(() => {
    const electron = window.electron;
    if (typeof window !== "undefined" && electron) {
      Promise.all([
        electron.needsWorkspaceSetup(),
        hydrateFromElectron(),
      ]).then(async ([needsSetup]) => {
        if (needsSetup) {
          setOnboardingState("workspace");
        } else {
          const ws = useCairnStore.getState().workspaces;
          setOnboardingState(ws.length === 0 ? "create" : false);
        }

        // Restore last pi session for the active project
        const state = useCairnStore.getState();
        const projId = state.activeProjectId;
        if (projId && window.electron) {
          try {
            await state.fetchPiSessionHistory(projId);
            const history = useCairnStore.getState().piSessionHistory;
            if (history.length > 0) {
              const latest = history[0];
              // Load messages for the latest session — session-as-truth (dsh JSONL),
              // SQLite fallback for pre-dsh sessions. Mirrors the chat load path.
              const rows = await (window.electron.piAgent as unknown as { getSessionMessages: (id: string) => Promise<unknown> }).getSessionMessages(latest.id) as Array<{
                id: string; role: "user" | "assistant" | "error"; content: string;
                reasoning: string | null;
                toolCalls: unknown[] | null; subagents: unknown[] | null; timestamp: string;
              }>;
              const piMessages = rows.map((r) => ({
                id: r.id,
                role: r.role,
                content: r.content,
                reasoning: r.reasoning ?? undefined,
                toolCalls: r.toolCalls ?? undefined,
                subagents: r.subagents ?? undefined,
                timestamp: r.timestamp,
              })) as import("@/store/slices/terminal-sessions").PiAgentMessage[];

              state.addTerminalSession({
                sessionId:   latest.id,
                taskId:      latest.taskId ?? latest.id,
                taskTitle:   latest.taskTitle,
                agentId:     "cairn-agent",
                agentName:   "Cairn Agent",
                projectId:   latest.projectId,
                cwd:         latest.cwd,
                status:      latest.status,
                exitCode:    null,
                spawnedAt:   latest.spawnedAt,
                sessionType: "pi",
                piMessages,
                mode:        latest.mode,
                planNoteId:  latest.planNoteId ?? undefined,
              });
              state.setPersistentPiSession(latest.id);
              // Restore LLM context in main process
              window.electron.piAgent.restoreContext(latest.id);
            }
          } catch (e) {
            console.error("[startup] failed to restore pi session", e);
          }
        }
      });

      // Track AI note writes (in-app chat executor + standalone MCP server) so
      // the db:changed handler below knows to re-hydrate and accept the AI's
      // content for those notes, overriding the own-write guard.
      const unsubAiStart = electron.onAiWriteStarted(({ noteId }) => {
        markAiNoteWriteStarted(noteId);
      });
      const unsubAiEnd = electron.onAiWriteEnded(({ noteId }) => {
        markAiNoteWriteEnded(noteId);
      });

      // Register db:changed listener synchronously so React gets the cleanup fn
      const unsubDb = electron.onDbChanged(() => {
        // Own writes are already reflected in Zustand via optimistic updates —
        // re-hydrating from SQLite would race against in-flight IPC and overwrite
        // the optimistic state with stale content. Skip hydration entirely.
        //
        // Exception: if the AI (chat executor or MCP) just wrote a note, the
        // surrounding chat IPC also touched ownWriteGuard — but those changes
        // are NOT in Zustand, so we must hydrate to surface them in the open
        // editor. A recent AI note write overrides the own-write skip.
        if (ownWriteGuard.isOwnWrite() && !hasRecentAiNoteWrite()) return;
        // Don't re-hydrate (and potentially reset onboardingState) while the
        // onboarding wizard is still in progress — folder selection and workspace
        // creation trigger db:changed but the wizard handles its own state.
        if (onboardingStateRef.current !== false) return;
        hydrateFromElectron(true);
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
        unsubAiStart();
        unsubAiEnd();
        unsubAvailable();
        unsubDownloaded();
      };
    } else {
      hydrate();
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
      else if (mod && e.shiftKey && key.toLowerCase() === "f") { if (activeView !== "agent") { e.preventDefault(); toggleSearch(); } }
      else if (mod && key === "/") {
        e.preventDefault();
        if (!hiddenViews.has("chat")) {
          if (activeView === "chat") {
            setView(lastContentView);
          } else {
            toggleChat();
          }
        }
      }
      else if (mod && key === "\\") { e.preventDefault(); toggleSidebar(); }
      else if (mod && key === "1") { e.preventDefault(); setView("overview"); }
      else if (mod && key === "2") { e.preventDefault(); setView("notes"); }
      else if (mod && /^[3-9]$/.test(key)) {
        const idx = parseInt(key, 10) - 3; // 0-based index into ORDERED_VIEWS
        const view = ORDERED_VIEWS[idx];
        if (view) { e.preventDefault(); setView(view); }
      }
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
      // ⌘⇧. — jump to onboarding appearance step (dev only)
      else if (process.env.NODE_ENV === "development" && mod && e.shiftKey && key === ".") {
        e.preventDefault();
        setOnboardingState("dev");
      }
    }
    function handleOpenChat(e: Event) {
      const { prefill, autoSend } = (e as CustomEvent<{ prefill: string; autoSend?: boolean }>).detail;
      setChatPrefill({ text: prefill, autoSend });
      if (!chatOpen) toggleChat();
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("cairn:open-chat", handleOpenChat);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("cairn:open-chat", handleOpenChat);
    };
  }, [toggleSearch, toggleChat, toggleSidebar, setView, activeProjectId, createNote, chatOpen, hiddenViews, ORDERED_VIEWS, activeView, lastContentView]);

  // Auto-activate Cairn Agent tab and auto-open right panel drawer if we switch to Agent view
  useEffect(() => {
    if (activeView === "agent") {
      const state = useCairnStore.getState();
      if (!state.chatOpen) {
        state.toggleChat();
      }
      // Only auto-activate the Cairn Agent (coding) session when the project has a codebase.
      const hasCodeDirectory = !!state.projects.find((p) => p.id === state.activeProjectId)?.codeDirectory;
      if (hasCodeDirectory && (state.activeSessionId === null || state.activeSessionId === "chat")) {
        if (state.persistentPiSessionId) {
          state.setActiveSession(state.persistentPiSessionId);
        }
      }
    }
  }, [activeView]);

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
  if (onboardingState === "workspace" || onboardingState === "create" || onboardingState === "dev") {
    const initialStep =
      onboardingState === "workspace" ? "choose-folder" :
      onboardingState === "create"    ? "workspace-details" :
      "appearance"; // "dev" — skip the workspace steps straight to the config flow

    return (
      <main className="flex flex-col h-dvh w-screen overflow-hidden bg-[var(--background)]">
        <TitleBar />
        <div className="flex flex-1 min-h-0">
          <Onboarding
            initialStep={initialStep}
            onComplete={(startTour) => {
              const state = useCairnStore.getState();
              completeOnboarding(startTour, {
                hydrateFromElectron,
                setOnboardingState,
                setPendingTutorial,
                setTutorialActive: state.setTutorialActive,
                getSeenFeatures: () => useCairnStore.getState().seenFeatures,
                registry: NEW_FEATURES_REGISTRY,
              });
            }}
          />
        </div>
      </main>
    );
  }

  // Main app
  // Top offset for fixed-position chrome (the chat panel): the title bar
  // occupies 40px (height:40 with box-sizing:border-box — the 1px bottom border
  // is INSIDE that box, not added), plus the update banner when visible. The
  // banner is `h-9` (2.25rem) in app-chrome.tsx, so we add the SAME rem-based
  // height here — a hard-coded px value would drift from the banner's real size
  // under applyFontScale() / --font-scale root sizing. The chat panel anchors to
  // this so it never overlaps the banner's download button and aligns with the
  // Topbar (which sits right below the title bar in normal flow).
  const updateBannerVisible = !!(updateVersion || updateDownloaded);
  const conflictBannerVisible = syncConflicts > 0;
  // Each banner is h-9 (2.25rem). Stack their heights onto the 40px title bar.
  const bannerRems = (updateBannerVisible ? 2.25 : 0) + (conflictBannerVisible ? 2.25 : 0);
  const chromeTop = bannerRems > 0 ? `calc(40px + ${bannerRems}rem)` : "40px";
  return (
    <main
      className="flex flex-col h-dvh w-screen overflow-hidden bg-[var(--background)]"
      style={{ "--chrome-top": chromeTop } as React.CSSProperties}
    >
      {/* Electron title bar — draggable, clears macOS traffic lights */}
      <TitleBar />

      {/* Running automations bar — thin accent strip shown while any automation run is in flight */}
      {runningAutomationCount > 0 && (
        <button
          onClick={() => setView("automations")}
          className="flex items-center gap-2 px-4 py-1 text-xs text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] border-b border-[color-mix(in_srgb,var(--accent)_20%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] transition-colors text-left"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
          {runningAutomationCount} automation{runningAutomationCount === 1 ? "" : "s"} running
          <span className="ml-auto text-[0.714rem] opacity-80">View →</span>
        </button>
      )}

      {/* Auto-update banner — shown as soon as we know a version is available or downloaded */}
      <UpdateBanner
        version={updateVersion}
        downloaded={updateDownloaded}
        onInstall={() => window.electron?.updater.install()}
        onDismiss={() => { setUpdateVersion(null); setUpdateDownloaded(false); }}
      />

      {/* Sync conflict banner — only when unresolved conflict copies exist */}
      <ConflictBanner />

      {/* Sync conflict resolution modal (opened from the banner or title-bar indicator) */}
      <ConflictResolutionModal open={conflictModalOpen} onClose={closeConflictModal} />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left sidebar */}
        <Sidebar />

        {/* Main content area */}
        <div
          className={cn(
            "flex flex-col flex-1 min-w-0 overflow-hidden",
            !chatPanelResizing && "transition-[margin-right] duration-300 ease-in-out"
          )}
          style={{
            marginRight: (activeView !== "chat" && chatOpen) ? "var(--chat-panel-width, 320px)" : "0px",
          }}
        >
          <Topbar />
          <div className="flex flex-1 min-h-0 overflow-hidden">
            {lastContentView === "overview"  && <ProjectOverview />}
            {lastContentView === "notes"     && <NotesView />}
            {lastContentView === "board"     && <KanbanBoard />}
            {lastContentView === "calendar"  && <CalendarView />}
            {lastContentView === "calendar-all" && <CalendarView scope="workspace" />}
            {lastContentView === "flow"      && <IdeaFlowView />}
           {lastContentView === "graph"     && <KnowledgeGraphView />}
            {lastContentView === "insights"  && <InsightsView />}
            {lastContentView === "automations" && <AutomationsView />}
            {lastContentView === "usage" && <UsageView />}
            {lastContentView === "settings"  && <SettingsView />}
           {/* AgentView stays mounted to preserve terminal sessions and agent state.
               CSS-hidden when inactive so xterm + AgentChatPane refs survive view switches. */}
           <div className={lastContentView === "agent" ? "contents" : "hidden"}>
             <AgentView />
           </div>
          </div>
        </div>

        {/* Unified Chat Panel (sidebar, center, or popout depending on state) */}
        <UnifiedChatPanel prefill={chatPrefill} onPrefillConsumed={() => setChatPrefill(null)} />

        {/* Global search overlay */}
        {searchOpen && <SearchPanel />}
      </div>

      {/* Notification center popover (top-right, thin; navigable rows) */}
      {notificationOpen && (
        <NotificationCenter onClose={() => setNotificationOpen(false)} />
      )}

      {/* IPC error toasts — bottom-right, auto-dismiss after 5s */}
      <ErrorToasts toasts={toasts} onDismiss={dismiss} />

      {/* New Feature Modal (shows on launch if unseen features exist) */}
      <NewFeatureModal onClose={handleNewFeatureModalClose} />

      {/* Interactive App Tutorial Overlay */}
      <AppTutorial />

      {/* Plugin-UI slots: frame-wide floating overlay (app.overlay) — the home
          for plugin-drawn chrome like a bouncing DVD logo, badges, toasts. */}
      <AppOverlayLayer activeView={activeView} activeProjectId={activeProjectId} />

      {/* Plugin-UI: persistent bottom status bar (app.statusbar). Renders nothing
          until a plugin registers an item, so layout is unaffected otherwise. */}
      <AppStatusBar activeView={activeView} activeProjectId={activeProjectId} />
    </main>
  );
}
