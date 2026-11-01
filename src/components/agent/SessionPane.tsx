"use client";

/**
 * SessionPane — tabbed container for Chat, Agent, and PTY terminal sessions.
 *
 * Renders xterm.js terminal sessions as tabs. Each session's Terminal
 * instance is held in TerminalManager (module-scope singleton), so sessions
 * survive navigation away from the Agent view.
 *
 * Chat and Agent panes are CSS-hidden (not unmounted) when inactive to
 * preserve IPC subscriptions, scroll position, and React state.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Plus, MessageSquarePlus, Code2, ExternalLink, ArrowLeftFromLine, Maximize2, Minimize2, MoreHorizontal, ChevronRight } from "lucide-react";
import { useCairnStore } from "@/store";
import { cn } from "@/lib/utils";
import { isView } from "@/lib/views";
import { IconButton } from "@/components/ui/icon-button";
import { modKey } from "@/components/layout/sidebar-utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { SpawnAgentModal } from "./SpawnAgentModal";
import { TerminalManager } from "./TerminalManager";
import { AgentChatPane } from "./AgentChatPane";
import { ChatPanel } from "@/components/chat/chat-panel";
import { SessionMount } from "./SessionMount";
import { TerminalTab } from "./TerminalTab";
import { AgentEmptyState } from "./AgentEmptyState";
import { useAgentSessionActions } from "./useAgentSessionActions";
import { SessionBrowser } from "./SessionBrowser";
import { chatSessionId } from "../../../shared/agent/session-identity";
import { useResizeObserver } from "@/lib/viz/hooks";

function sanitizeAriaId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

interface SessionPaneProps {
  isRightPanel?: boolean;
  chatPrefill?: { text: string; autoSend?: boolean } | null;
  onPrefillConsumed?: () => void;
}

export function SessionPane({ isRightPanel = false, chatPrefill = null, onPrefillConsumed }: SessionPaneProps = {}) {
  const {
    terminalSessions,
    activeSessionId,
    setActiveSession,
    openSession,
    removeTerminalSession,
    activeCodingSessionId,
    activeProjectId,
    toggleChat,
    activeView,
    chatOpen,
    projects,
    chatPoppedOut,
    setChatPoppedOut,
    setView,
    setSessionPresentation,
    lastContentView,
  } = useCairnStore(useShallow((s) => ({
    terminalSessions: s.terminalSessions,
    activeSessionId: s.activeSessionId,
    setActiveSession: s.setActiveSession,
    openSession: s.openSession,
    removeTerminalSession: s.removeTerminalSession,
    activeCodingSessionId: s.activeCodingSessionId,
    activeProjectId: s.activeProjectId,
    toggleChat: s.toggleChat,
    activeView: s.activeView,
    chatOpen: s.chatOpen,
    projects: s.projects,
    chatPoppedOut: s.chatPoppedOut,
    setChatPoppedOut: s.setChatPoppedOut,
    setView: s.setView,
    setSessionPresentation: s.setSessionPresentation,
    lastContentView: s.lastContentView,
  })));

  const hasCodeDirectory = !!projects.find((p) => p.id === activeProjectId)?.codeDirectory;

  const [spawnOpen, setSpawnOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [mod] = useState(() => modKey());
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerOverflows, setHeaderOverflows] = useState(false);

  const createNewThread = useCairnStore((s) => s.createNewThread);
  const activeWorkspaceId = useCairnStore((s) => s.activeWorkspaceId);
  const fetchCodingSessionHistoryForProjects = useCairnStore((s) => s.fetchCodingSessionHistoryForProjects);
  const { handleNewSession } = useAgentSessionActions();

  function handleNewChatThread() {
    if (!activeWorkspaceId) return;
    setNewMenuOpen(false);
    const thread = createNewThread(activeWorkspaceId, activeProjectId ?? undefined);
    openSession(thread.id, "chat", "drawer");
  }

  async function handleNewAgentSession() {
    setNewMenuOpen(false);
    setSessionPresentation("drawer");
    await handleNewSession();
  }

  // Memoized project ids key — avoids refetch loop when `projects` array
  // identity changes on every hydrate (store replaces array reference).
  const projectIdsKey = useMemo(() => {
    if (!activeWorkspaceId) return "";
    return projects
      .filter((p) => p.workspaceId === activeWorkspaceId)
      .map((p) => p.id)
      .sort()
      .join(",");
  }, [projects, activeWorkspaceId]);
  const prevProjectIdsKeyRef = useRef<string>("");
  useEffect(() => {
    if (!activeWorkspaceId) return;
    if (projectIdsKey === prevProjectIdsKeyRef.current) return;
    prevProjectIdsKeyRef.current = projectIdsKey;
    const ids = projectIdsKey ? projectIdsKey.split(",") : [];
    if (ids.length === 0) return;
    void fetchCodingSessionHistoryForProjects(ids);
  }, [activeWorkspaceId, fetchCodingSessionHistoryForProjects, projectIdsKey]);

  const handleClose = useCallback((sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    TerminalManager.delete(sessionId);
    removeTerminalSession(sessionId);
    window.electron?.agent.kill(sessionId).catch(console.error);
  }, [removeTerminalSession]);

  const persistentSession = terminalSessions.find((t) => t.sessionId === activeCodingSessionId && t.sessionType === "coding");
  const ptySessions = terminalSessions.filter((t) => t.sessionType === "pty");

  // Collapse to hamburger when the panel is narrow (<360) — a scrollWidth
  // check flickers when we hide content, so use a width threshold.
  useResizeObserver(headerRef, (el) => setHeaderOverflows(el.clientWidth < 360), [ptySessions.length, activeSessionId]);

  useEffect(() => {
    if (activeSessionId === null) {
      setActiveSession("chat");
    }
  }, [activeSessionId, setActiveSession]);

  useEffect(() => {
    if (!hasCodeDirectory && activeSessionId !== "chat" && activeSessionId !== null) {
      const isAgentSession =
        activeSessionId === "agent" ||
        (activeCodingSessionId !== null && activeSessionId === activeCodingSessionId);
      if (isAgentSession) setActiveSession("chat");
    }
  }, [hasCodeDirectory, activeSessionId, activeCodingSessionId, setActiveSession]);

  const prevChatOpenRef = useRef(chatOpen);

  useEffect(() => {
    // Default the active session to "chat" when the chat panel is OPENED while
    // not in the agent view (you clicked Chat, you see Chat). We deliberately do
    // NOT reset the session when merely navigating AWAY from the agent view —
    // that would yank the user off a live agent conversation every time they hop
    // into Settings or another view; the agent tab is restored on return.
    const chatOpenedOutsideAgent = !prevChatOpenRef.current && chatOpen && !isView(activeView, "agent");

    if (chatOpenedOutsideAgent) {
      setActiveSession("chat");
    }

    prevChatOpenRef.current = chatOpen;
  }, [activeView, chatOpen, setActiveSession]);

  // ── Pop-out session ─────────────────────────────────────────────────────────────
  const handlePopOut = useCallback(async () => {
    const state = useCairnStore.getState();
    const isChat = state.activeSessionId === "chat";
    // Single lookup: resolve the coding session id once (handles the "agent" alias)
    const codingSessionId = state.activeSessionId === "agent" ? state.activeCodingSessionId : state.activeSessionId;
    const coding = codingSessionId ? state.terminalSessions.find((s) => s.sessionId === codingSessionId && s.sessionType === "coding") : undefined;
    const sessionId = isChat ? (state.activeChatThreadId ? chatSessionId(state.activeChatThreadId) : null) : coding?.sessionId;
    if (!sessionId) return;
    const project = state.projects.find((item) => item.id === (coding?.projectId ?? state.activeProjectId));
    const result = await window.electron?.chat.popOut({
      sessionId,
      activeProjectId: coding?.projectId ?? state.activeProjectId,
      profile: isChat ? "chat" : coding?.role === "automation-dev" ? "automation-dev" : "coding",
      workspaceId: project?.workspaceId ?? state.activeWorkspaceId,
      cwd: coding?.cwd ?? null,
    }) as { ok: boolean; reason?: string } | undefined;
    if (result?.ok) {
      setChatPoppedOut(true);
    } else if (result && !result.ok) {
      const reason = result.reason ?? "unknown";
      const message =
        reason === "profile-mismatch"
          ? "Pop-out failed — profile mismatch"
          : reason === "invalid-payload"
            ? "Pop-out failed — invalid session"
            : `Pop-out failed — ${reason}`;
      window.dispatchEvent(new CustomEvent("cairn:ipc-error", { detail: { message } }));
    }
  }, [setChatPoppedOut]);

  const handlePopIn = useCallback(() => {
    window.electron?.chat.requestPopIn();
  }, []);

  const handleClosePanel = useCallback(() => {
    if (!isRightPanel) {
      // Center mode is visible independently of chatOpen. setView() restores
      // the drawer presentation (see the ui slice), then close the drawer only
      // when it is open; this prevents "Close panel" from leaving the centered
      // session on screen or opening a drawer that was never open.
      setView(lastContentView);
      if (chatOpen) toggleChat();
      return;
    }
    toggleChat();
  }, [chatOpen, isRightPanel, lastContentView, setView, toggleChat]);

  // Listen for pop-in final state from the main process
  useEffect(() => {
    const electron = window.electron;
    if (!electron?.chat.onChatPoppedIn) return;
    const unsub = electron.chat.onChatPoppedIn((_payload) => {
      setChatPoppedOut(false);
    });
    return () => { unsub?.(); };
  }, [setChatPoppedOut]);

  // Pop-out window closed unexpectedly (e.g. Cmd+W)
  useEffect(() => {
    const electron = window.electron;
    if (!electron?.chat.onChatPoppedOutClosed) return;
    const unsub = electron.chat.onChatPoppedOutClosed(() => {
      setChatPoppedOut(false);
    });
    return () => { unsub?.(); };
  }, [setChatPoppedOut]);

  const pinnedIsActive =
    activeSessionId === "agent" ||
    (activeCodingSessionId !== null && activeSessionId === activeCodingSessionId);

  return (
    <>
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Tab bar — instrument header, matches rail grammar */}
      <div ref={headerRef} className="flex items-center h-11 px-1.5 gap-1.5 border-b border-[var(--border)] overflow-visible relative z-20 flex-shrink-0 bg-[var(--surface)] shadow-[inset_0_1px_0_color-mix(in_srgb,white_4%,transparent)] min-w-0 flex-nowrap">
        {/* Session switcher — flexes so + never gets pushed off (outer must be overflow-visible so dropdown isn't clipped) */}
        <div className="flex-1 min-w-0 max-w-[220px] overflow-visible">
          <SessionBrowser activeSessionId={activeSessionId} variant="dropdown" />
        </div>
        <div
          role="tablist"
          aria-orientation="horizontal"
          aria-label="Terminal tabs"
          className={cn(
            "flex items-center gap-1 min-w-0 h-full overflow-x-auto overflow-y-hidden scrollbar-thin scrollbar-thumb-[var(--text-tertiary)] hover:scrollbar-thumb-[var(--text-secondary)] scrollbar-track-transparent [scrollbar-width:thin] [scrollbar-gutter:stable] [scrollbar-color:var(--text-tertiary)_transparent] py-1",
            ptySessions.length > 0 ? "flex-1" : "flex-shrink-0",
            ptySessions.length >= 4 && "[mask-image:linear-gradient(to_right,transparent,black_8px,black_calc(100%-8px),transparent)]",
          )}
          style={{ scrollbarWidth: "thin", scrollbarColor: "var(--text-tertiary) transparent" }}
        >
          {ptySessions.map((session) => (
            <TerminalTab
              key={session.sessionId}
              session={session}
              isActive={session.sessionId === activeSessionId}
              onActivate={() => openSession(session.sessionId, "terminal", "drawer")}
              onClose={(e) => handleClose(session.sessionId, e)}
            />
          ))}
        </div>

        {/* New chat thread / agent session menu */}
        <div className="flex-shrink-0 ml-auto">
          <DropdownMenu open={newMenuOpen} onOpenChange={setNewMenuOpen}>
            <DropdownMenuTrigger asChild>
              <IconButton id="unified-new-btn" label="New chat or agent session" variant="outline" active={newMenuOpen} tooltipDisabled={newMenuOpen}>
                <Plus size={12} strokeWidth={1.75} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem id="new-chat-thread-btn" onSelect={handleNewChatThread} className="items-start py-2">
                <MessageSquarePlus size={13} className="mt-0.5 flex-shrink-0 text-[var(--accent)]" />
                <span>
                  <span className="block font-medium text-[var(--text-primary)]">New chat thread</span>
                  <span className="block text-2xs text-[var(--text-tertiary)]">Start a fresh AI conversation</span>
                </span>
              </DropdownMenuItem>
              {hasCodeDirectory && (
                <DropdownMenuItem id="new-agent-session-btn" onSelect={() => void handleNewAgentSession()} className="items-start py-2">
                  <Code2 size={13} className="mt-0.5 flex-shrink-0 text-[var(--accent)]" />
                  <span>
                    <span className="block font-medium text-[var(--text-primary)]">New agent session</span>
                    <span className="block text-2xs text-[var(--text-tertiary)]">Cairn Agent coding session</span>
                  </span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Header Actions — pop out + expand, collapse to hamburger when clipped */}
        <div className={cn("flex items-center gap-1 shrink-0", headerOverflows && "hidden")}>
          {(activeSessionId === "chat" || activeSessionId === "agent" || persistentSession?.sessionId === activeSessionId) && !chatPoppedOut && (
            <IconButton label="Pop out session window" onClick={handlePopOut}>
              <ExternalLink size={12} />
            </IconButton>
          )}

          {isRightPanel ? (
            <IconButton
              label="Expand to central view"
              // setView("chat") also flips the presentation to center (single
              // store update — no intermediate drawer/center flash).
              onClick={() => setView("chat")}
            >
              <Maximize2 size={12} />
            </IconButton>
          ) : (
            <IconButton
              label="Collapse to sidebar"
              shortcut={`${mod}/`}
              // setView() back to the content view also restores the drawer
              // presentation — one update, no stuck-overlay state.
              onClick={() => setView(lastContentView)}
            >
              <Minimize2 size={12} />
            </IconButton>
          )}
        </div>

        {headerOverflows && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label="More actions" variant="outline">
                <MoreHorizontal size={12} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {(activeSessionId === "chat" || activeSessionId === "agent" || persistentSession?.sessionId === activeSessionId) && !chatPoppedOut && (
                <DropdownMenuItem onClick={handlePopOut} className="flex items-center gap-2 text-xs">
                  <ExternalLink size={12} /> Pop out session
                </DropdownMenuItem>
              )}
              {isRightPanel ? (
                <DropdownMenuItem onClick={() => setView("chat")} className="flex items-center gap-2 text-xs">
                  <Maximize2 size={12} /> Expand to center
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => setView(lastContentView)} className="flex items-center gap-2 text-xs">
                  <Minimize2 size={12} /> Collapse to sidebar
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <IconButton label="Collapse panel" shortcut={`${mod}/`} variant="outline" onClick={handleClosePanel}>
          <ChevronRight size={12} />
        </IconButton>
      </div>

      {/* Session content — CSS-hidden instead of unmounted */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-[var(--background)]">
        <div
          role="tabpanel"
          id="panel-chat"
          aria-labelledby="tab-chat"
          hidden={activeSessionId !== "chat"}
          aria-hidden={activeSessionId !== "chat"}
          {...(activeSessionId !== "chat" ? ({ inert: true } as unknown as React.HTMLAttributes<HTMLDivElement>) : {})}
          className={activeSessionId === "chat" ? "flex flex-1 flex-col min-h-0 overflow-hidden" : "hidden"}
        >
          {chatPoppedOut ? (
            <div className="flex flex-col items-center justify-center flex-1 gap-2 text-center px-6">
              <ExternalLink size={20} className="text-[var(--text-tertiary)]" />
              <p className="text-xs text-[var(--text-secondary)]">Session is in a pop-out window</p>
              <button
                onClick={handlePopIn}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs text-[var(--text-primary)] bg-[var(--surface-3)] hover:bg-[var(--surface-4)] transition-colors"
              >
                <ArrowLeftFromLine size={11} />
                Pop in
              </button>
            </div>
          ) : (
            <ChatPanel prefill={chatPrefill} onPrefillConsumed={onPrefillConsumed} />
          )}
        </div>

        {hasCodeDirectory && (
          persistentSession ? (
            <div
              role="tabpanel"
              id="panel-agent"
              aria-labelledby="tab-agent"
              hidden={!pinnedIsActive}
              aria-hidden={!pinnedIsActive}
              {...(!pinnedIsActive ? ({ inert: true } as unknown as React.HTMLAttributes<HTMLDivElement>) : {})}
              className={pinnedIsActive ? "flex flex-col flex-1 min-h-0 overflow-hidden" : "hidden"}
            >
              {chatPoppedOut && (persistentSession.sessionId === activeSessionId || activeSessionId === "agent") ? (
                <div className="flex flex-col items-center justify-center flex-1 gap-2 text-center px-6">
                  <ExternalLink size={20} className="text-[var(--text-tertiary)]" />
                  <p className="text-xs text-[var(--text-secondary)]">Session is in a pop-out window</p>
                  <button onClick={handlePopIn} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs text-[var(--text-primary)] bg-[var(--surface-3)] hover:bg-[var(--surface-4)] transition-colors"><ArrowLeftFromLine size={11} /> Pop in</button>
                </div>
              ) : <AgentChatPane session={persistentSession} isActive={pinnedIsActive} />}
            </div>
          ) : pinnedIsActive ? (
            <div
              role="tabpanel"
              id="panel-agent"
              aria-labelledby="tab-agent"
              className="flex-1 min-h-0 overflow-hidden"
            >
              <AgentEmptyState />
            </div>
          ) : null
        )}

        {ptySessions.map((session) => {
          const tabId = `tab-${sanitizeAriaId(session.sessionId)}`;
          const panelId = `panel-${sanitizeAriaId(session.sessionId)}`;
          const isActive = session.sessionId === activeSessionId;
          return (
            <div
              key={session.sessionId}
              role="tabpanel"
              id={panelId}
              aria-labelledby={tabId}
              hidden={!isActive}
              className={cn("flex-1 min-h-0 flex flex-col overflow-hidden", !isActive && "hidden")}
            >
              <SessionMount
                session={session}
                isActive={isActive}
              />
            </div>
          );
        })}
      </div>
    </div>
    <SpawnAgentModal open={spawnOpen} onClose={() => setSpawnOpen(false)} />
    </>
  );
}
