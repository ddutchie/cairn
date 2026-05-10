"use client";

// xterm.css must be imported at module level — without it the textarea and
// screen elements render as unstyled DOM, producing the visible textarea artifact.
import "@xterm/xterm/css/xterm.css";

/**
 * AgentTerminalPane — right pane of the Agent view.
 *
 * Renders xterm.js terminal sessions as tabs. Each session's Terminal
 * instance is held in TerminalManager (module-scope singleton), so sessions
 * survive navigation away from the Agent view.
 *
 * Inactive session divs are CSS-hidden (not unmounted) to preserve scroll history.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { X, MessageSquare, CircleDot, Plus, ChevronDown, Trash2, Bot, History, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { id } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { Tooltip } from "@/components/ui/tooltip";
import { SpawnAgentModal } from "./SpawnAgentModal";
import { TerminalManager } from "./TerminalManager";
import { PiAgentPane } from "./PiAgentPane";
import type { TerminalSession, PiSessionSummary } from "@/store/slices/terminal-sessions";

// ── Single terminal session mount ─────────────────────────────────────────────

interface SessionMountProps {
  session: TerminalSession;
  isActive: boolean;
}

function SessionMount({ session, isActive }: SessionMountProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initStarted = useRef(false);
  const cleanupFns = useRef<Array<() => void>>([]);
  const markSessionExited = useCairnStore((s) => s.markSessionExited);
  const fontScale         = useCairnStore((s) => s.fontScale);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ── Case 1: terminal already exists — re-attach and refit ──────────────
    if (TerminalManager.has(session.sessionId)) {
      const m = TerminalManager.get(session.sessionId)!;
      if (m.terminal.element && !container.contains(m.terminal.element)) {
        container.innerHTML = "";
        container.appendChild(m.terminal.element);
      }
      TerminalManager.fit(session.sessionId);
      return;
    }

    // ── Case 2: StrictMode second-invoke guard ──────────────────────────────
    if (initStarted.current) return;
    initStarted.current = true;

    // ── Case 3: create a new terminal ──────────────────────────────────────
    let unmounted = false;
    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { Unicode11Addon } = await import("@xterm/addon-unicode11");

      // Guard: component may have unmounted while awaiting dynamic imports
      if (unmounted || !containerRef.current) return;

      const cs = getComputedStyle(document.documentElement);
      const resolvedFont = cs.getPropertyValue("--font-mono").trim()
        || "ui-monospace, 'Cascadia Code', 'Fira Code', monospace";
      const fontScale = parseFloat(cs.getPropertyValue("--font-scale").trim() || "1") || 1;
      const fontSize = Math.round(11 * fontScale);

      const terminal = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        fontSize,
        fontFamily: resolvedFont,
        // Set a reasonable initial size so xterm doesn't start at 80×24
        // and immediately jump — FitAddon will correct it once cell dims are known.
        cols: Math.max(40, Math.floor(containerRef.current.offsetWidth / 8)),
        rows: Math.max(10, Math.floor(containerRef.current.offsetHeight / 17)),
        theme: {
          background: cs.getPropertyValue("--background").trim() || "#111111",
          foreground: cs.getPropertyValue("--text-primary").trim() || "#e5e5e5",
          cursor:     cs.getPropertyValue("--accent").trim()       || "#6366f1",
          selectionBackground: cs.getPropertyValue("--accent-dim").trim() || "#6366f133",
        },
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      const unicode11 = new Unicode11Addon();
      terminal.loadAddon(unicode11);
      terminal.unicode.activeVersion = "11";

      containerRef.current.innerHTML = "";
      terminal.open(containerRef.current);

      TerminalManager.set(session.sessionId, { terminal, fitAddon, rawOutput: "" });

      // FitAddon.proposeDimensions() needs xterm's _renderService.dimensions
      // to have non-zero cell sizes, which only happen after the first paint.
      // Use a ResizeObserver: it fires after layout so cell sizes are valid.
      // Disconnect after first successful fit — AgentView.fitAll() handles the rest.
      const ro = new ResizeObserver(() => {
        const dims = fitAddon.proposeDimensions();
        if (dims && dims.cols > 0 && dims.rows > 0) {
          fitAddon.fit();
          ro.disconnect();
        }
      });
      ro.observe(containerRef.current);
      // Safety: disconnect after 2s even if proposeDimensions never returns valid dims
      const roTimeout = setTimeout(() => ro.disconnect(), 2000);

      // Forward keystrokes → PTY
      const d1 = terminal.onData((data: string) => {
        window.electron?.agent.input(session.sessionId, data);
      });

      // Forward resize → PTY
      const d2 = terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        window.electron?.agent.resize(session.sessionId, cols, rows);
      });

      // Stream PTY output → terminal
      const offData = window.electron?.agent.onData(
        ({ sessionId, data }: { sessionId: string; data: string }) => {
          if (sessionId !== session.sessionId) return;
          terminal.write(data);
          TerminalManager.appendOutput(sessionId, data);
        }
      );

      const offExit = window.electron?.agent.onExit(
        ({ sessionId, exitCode }: { sessionId: string; exitCode: number }) => {
          if (sessionId !== session.sessionId) return;
          markSessionExited(sessionId, exitCode);
          terminal.writeln(`\r\n\x1b[33m[Process exited with code ${exitCode}]\x1b[0m`);
        }
      );

      cleanupFns.current = [
        () => { ro.disconnect(); clearTimeout(roTimeout); },
        () => d1.dispose(),
        () => d2.dispose(),
        () => offData?.(),
        () => offExit?.(),
      ];
    })();

    return () => {
      unmounted = true;
      cleanupFns.current.forEach((fn) => fn());
      cleanupFns.current = [];
      initStarted.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId]);

  // Refit when becoming active (hidden→visible changes layout)
  useEffect(() => {
    if (isActive) TerminalManager.fit(session.sessionId);
  }, [isActive, session.sessionId]);

  // Update font size when the user changes the font scale setting.
  // requestAnimationFrame defers fit() by one frame so xterm's canvas
  // can re-measure cell dimensions after the font size change.
  useEffect(() => {
    const m = TerminalManager.get(session.sessionId);
    if (!m) return;
    m.terminal.options.fontSize = Math.round(11 * fontScale);
    const raf = requestAnimationFrame(() => TerminalManager.fit(session.sessionId));
    return () => cancelAnimationFrame(raf);
  }, [fontScale, session.sessionId]);

  return (
    <div
      className={cn("flex-1 min-h-0 overflow-hidden relative", !isActive && "hidden")}
      ref={containerRef}
      style={{ background: "var(--background)", height: "100%", width: "100%" }}
    />
  );
}

function formatDate(iso: string) {
  const d = new Date(iso);
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── PiAgentEmptyState — shown in the content area when no session is loaded ──

function PiAgentEmptyState() {
  const {
    piSessionHistory,
    persistentPiSessionId,
    setPersistentPiSession,
    addTerminalSession,
    setActiveSession,
    terminalSessions,
    activeProjectId,
    projects,
    upsertPiSessionSummary,
  } = useCairnStore(useShallow((s) => ({
    piSessionHistory:       s.piSessionHistory,
    persistentPiSessionId:  s.persistentPiSessionId,
    setPersistentPiSession: s.setPersistentPiSession,
    addTerminalSession:     s.addTerminalSession,
    setActiveSession:       s.setActiveSession,
    terminalSessions:       s.terminalSessions,
    activeProjectId:        s.activeProjectId,
    projects:               s.projects,
    upsertPiSessionSummary: s.upsertPiSessionSummary,
  })));

  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const recentSessions = piSessionHistory.slice(0, 5);

  async function handleNewSession() {
    if (!project?.codeDirectory || !activeProjectId) return;
    const sessionId = id();
    const now = new Date().toISOString();
    const summary: PiSessionSummary = {
      id: sessionId,
      projectId: activeProjectId,
      taskTitle: "Ad-hoc session",
      taskId: null,
      cwd: project.codeDirectory,
      mode: "execute" as const,
      planNoteId: null,
      status: "running" as const,
      spawnedAt: now,
      updatedAt: now,
    };
    try { await window.electron?.piAgent.createSession(summary); } catch { /* ok */ }
    addTerminalSession({
      sessionId, taskId: sessionId, taskTitle: "Ad-hoc session",
      agentId: "cairn-agent", agentName: "Cairn Agent",
      projectId: activeProjectId, cwd: project.codeDirectory,
      status: "running", exitCode: null, spawnedAt: now,
      sessionType: "pi", piMessages: [], mode: "execute",
    });
    upsertPiSessionSummary(summary);
    setPersistentPiSession(sessionId);
    setActiveSession(sessionId);
  }

  async function handleResumeSession(summary: PiSessionSummary) {
    const alreadyLoaded = terminalSessions.find((t) => t.sessionId === summary.id);
    if (!alreadyLoaded) {
      let piMessages: import("@/store/slices/terminal-sessions").PiAgentMessage[] = [];
      try {
        const rows = await window.electron?.piAgent.getMessages(summary.id) as Array<{
          id: string; role: "user" | "assistant" | "error"; content: string;
          toolCalls: unknown[] | null; subagents: unknown[] | null; timestamp: string;
        }> | undefined;
        if (rows) {
          piMessages = rows.map((r) => ({
            id: r.id, role: r.role, content: r.content,
            toolCalls: (r.toolCalls ?? undefined) as import("@/store/slices/terminal-sessions").PiAgentMessage["toolCalls"],
            subagents: (r.subagents ?? undefined) as import("@/store/slices/terminal-sessions").PiAgentMessage["subagents"],
            timestamp: r.timestamp,
          }));
        }
      } catch { /* ok */ }
      window.electron?.piAgent.restoreContext(summary.id);
      addTerminalSession({
        sessionId: summary.id, taskId: summary.taskId ?? summary.id,
        taskTitle: summary.taskTitle, agentId: "cairn-agent", agentName: "Cairn Agent",
        projectId: summary.projectId, cwd: summary.cwd, status: summary.status,
        exitCode: null, spawnedAt: summary.spawnedAt, sessionType: "pi",
        piMessages, mode: summary.mode, planNoteId: summary.planNoteId ?? undefined,
      });
    } else {
      window.electron?.piAgent.restoreContext(summary.id);
    }
    setPersistentPiSession(summary.id);
    setActiveSession(summary.id);
  }



  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-6 text-center">
      <div className="w-10 h-10 rounded-full bg-[var(--accent-dim)] border border-[var(--accent)]/20 flex items-center justify-center">
        <Bot size={18} className="text-[var(--accent)]" />
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-[0.786rem] font-semibold text-[var(--text-primary)]">Cairn Agent</p>
        <p className="text-[0.714rem] text-[var(--text-tertiary)] max-w-44">
          {project?.codeDirectory
            ? "Start a new session or resume a previous one."
            : "Set a code directory on this project to start a session."}
        </p>
      </div>

      {/* New session CTA */}
      <button
        onClick={handleNewSession}
        disabled={!project?.codeDirectory}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[0.714rem] font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Plus size={11} />
        New session
      </button>

      {/* Recent sessions */}
      {recentSessions.length > 0 && (
        <div className="w-full max-w-56 flex flex-col gap-0.5 mt-1">
          <div className="flex items-center gap-1.5 mb-1">
            <History size={10} className="text-[var(--text-tertiary)]" />
            <span className="text-[0.643rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wider">Recent</span>
          </div>
          {recentSessions.map((summary) => (
            <button
              key={summary.id}
              onClick={() => handleResumeSession(summary)}
              className={cn(
                "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors",
                "hover:bg-[var(--surface-2)] border border-transparent hover:border-[var(--border)]",
                summary.id === persistentPiSessionId && "bg-[var(--surface-2)] border-[var(--border)]",
              )}
            >
              <div className="flex-1 min-w-0">
                <p className="text-[0.714rem] text-[var(--text-secondary)] truncate">{summary.taskTitle}</p>
                <p className="text-[0.607rem] text-[var(--text-tertiary)]">{formatDate(summary.updatedAt)}</p>
              </div>
              <ArrowRight size={10} className="text-[var(--text-tertiary)] shrink-0 opacity-0 group-hover:opacity-100" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── PiAgentTab (pinned Cairn Agent tab with history dropdown) ──────────────

interface PiAgentTabProps {
  isActive: boolean;
  onActivate: () => void;
}

function PiAgentTab({ isActive, onActivate }: PiAgentTabProps) {
  const {
    piSessionHistory,
    persistentPiSessionId,
    setPersistentPiSession,
    fetchPiSessionHistory,
    deletePiSessionFromHistory,
    addTerminalSession,
    setActiveSession,
    terminalSessions,
    activeProjectId,
    projects,
    upsertPiSessionSummary,
  } = useCairnStore(useShallow((s) => ({
    piSessionHistory:           s.piSessionHistory,
    persistentPiSessionId:      s.persistentPiSessionId,
    setPersistentPiSession:     s.setPersistentPiSession,
    fetchPiSessionHistory:      s.fetchPiSessionHistory,
    deletePiSessionFromHistory: s.deletePiSessionFromHistory,
    addTerminalSession:         s.addTerminalSession,
    setActiveSession:           s.setActiveSession,
    terminalSessions:           s.terminalSessions,
    activeProjectId:            s.activeProjectId,
    projects:                   s.projects,
    upsertPiSessionSummary:     s.upsertPiSessionSummary,
  })));

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [dropdownOpen]);

  // Refresh history when dropdown opens
  useEffect(() => {
    if (dropdownOpen && activeProjectId) {
      fetchPiSessionHistory(activeProjectId);
    }
  }, [dropdownOpen, activeProjectId, fetchPiSessionHistory]);

  async function handleNewSession() {
    setDropdownOpen(false);
    if (!project?.codeDirectory || !activeProjectId) return;
    const sessionId = id();
    const now = new Date().toISOString();
    const summary: PiSessionSummary = {
      id: sessionId,
      projectId: activeProjectId,
      taskTitle: "Ad-hoc session",
      taskId: null,
      cwd: project.codeDirectory,
      mode: "execute" as const,
      planNoteId: null,
      status: "running" as const,
      spawnedAt: now,
      updatedAt: now,
    };
    try {
      await window.electron?.piAgent.createSession(summary);
    } catch (e) {
      console.error("[PiAgentTab] createSession failed", e);
    }
    addTerminalSession({
      sessionId,
      taskId: sessionId,
      taskTitle: "Ad-hoc session",
      agentId: "cairn-agent",
      agentName: "Cairn Agent",
      projectId: activeProjectId,
      cwd: project.codeDirectory,
      status: "running",
      exitCode: null,
      spawnedAt: now,
      sessionType: "pi",
      piMessages: [],
      mode: "execute",
    });
    upsertPiSessionSummary(summary);
    setPersistentPiSession(sessionId);
    setActiveSession(sessionId);
  }

  async function handleResumeSession(summary: PiSessionSummary) {
    setDropdownOpen(false);
    if (summary.id === persistentPiSessionId) return;

    // Check if already loaded in terminalSessions
    const alreadyLoaded = terminalSessions.find((t) => t.sessionId === summary.id);
    if (!alreadyLoaded) {
      // Load messages from SQLite
      let piMessages: import("@/store/slices/terminal-sessions").PiAgentMessage[] = [];
      try {
        const rows = await window.electron?.piAgent.getMessages(summary.id) as Array<{
          id: string; role: "user" | "assistant" | "error"; content: string;
          toolCalls: unknown[] | null; subagents: unknown[] | null; timestamp: string;
        }> | undefined;
        if (rows) {
          piMessages = rows.map((r) => ({
            id: r.id,
            role: r.role,
            content: r.content,
            toolCalls: (r.toolCalls ?? undefined) as import("@/store/slices/terminal-sessions").PiAgentMessage["toolCalls"],
            subagents: (r.subagents ?? undefined) as import("@/store/slices/terminal-sessions").PiAgentMessage["subagents"],
            timestamp: r.timestamp,
          }));
        }
      } catch (e) {
        console.error("[PiAgentTab] getMessages failed", e);
      }

      // Restore LLM context in main process
      window.electron?.piAgent.restoreContext(summary.id);

      addTerminalSession({
        sessionId:   summary.id,
        taskId:      summary.taskId ?? summary.id,
        taskTitle:   summary.taskTitle,
        agentId:     "cairn-agent",
        agentName:   "Cairn Agent",
        projectId:   summary.projectId,
        cwd:         summary.cwd,
        status:      summary.status,
        exitCode:    null,
        spawnedAt:   summary.spawnedAt,
        sessionType: "pi",
        piMessages,
        mode:        summary.mode,
        planNoteId:  summary.planNoteId ?? undefined,
      });
    } else {
      // Already loaded — still restore context in case of restart
      window.electron?.piAgent.restoreContext(summary.id);
    }

    setPersistentPiSession(summary.id);
    setActiveSession(summary.id);
  }

  async function handleDeleteSession(e: React.MouseEvent, sessionId: string) {
    e.stopPropagation();
    await deletePiSessionFromHistory(sessionId);
  }

  function formatDate(iso: string) {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  return (
    <div className="relative flex-shrink-0" ref={dropdownRef}>
      {/* The pinned tab button */}
      <button
        onClick={onActivate}
        role="tab"
        aria-selected={isActive}
        className={cn(
          "flex items-center gap-1.5 px-3 py-2 text-[0.714rem] whitespace-nowrap border-r border-[var(--border)] transition-colors flex-shrink-0",
          isActive
            ? "text-[var(--text-primary)] bg-[var(--background)]"
            : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
        )}
      >
        <MessageSquare size={8} className={cn("flex-shrink-0", isActive ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]")} />
        <span className="max-w-[100px] truncate">Cairn Agent</span>
        {/* History dropdown chevron */}
        <span
          role="button"
          aria-label="Session history"
          onClick={(e) => { e.stopPropagation(); setDropdownOpen((v) => !v); }}
          className={cn(
            "ml-0.5 p-0.5 rounded transition-colors hover:bg-[var(--surface-2)]",
            dropdownOpen ? "text-[var(--text-primary)]" : "text-[var(--text-tertiary)]"
          )}
        >
          <ChevronDown size={10} />
        </span>
      </button>

      {/* History dropdown */}
      {dropdownOpen && (
        <div className="absolute left-0 top-full z-50 mt-0.5 w-64 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl overflow-hidden">
          {/* New session CTA */}
          <button
            onClick={handleNewSession}
            disabled={!project?.codeDirectory}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-[0.714rem] font-medium text-[var(--accent)] hover:bg-[var(--surface-2)] transition-colors border-b border-[var(--border)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus size={11} />
            New session
            {!project?.codeDirectory && <span className="ml-auto text-[var(--text-tertiary)] text-[0.643rem]">No code dir</span>}
          </button>

          {/* History list */}
          <div className="max-h-64 overflow-y-auto">
            {piSessionHistory.length === 0 ? (
              <p className="px-3 py-3 text-[0.714rem] text-[var(--text-tertiary)] text-center">No saved sessions</p>
            ) : (
              piSessionHistory.map((summary) => (
                <button
                  key={summary.id}
                  onClick={() => handleResumeSession(summary)}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--surface-2)] transition-colors group",
                    summary.id === persistentPiSessionId && "bg-[var(--surface-2)]"
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-[0.714rem] text-[var(--text-primary)] truncate">{summary.taskTitle}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={cn(
                        "text-[0.607rem] font-medium px-1 py-0 rounded",
                        summary.mode === "plan"
                          ? "bg-[color-mix(in_srgb,var(--warning,#f59e0b)_15%,transparent)] text-[var(--warning,#f59e0b)]"
                          : "bg-[var(--accent-dim)] text-[var(--accent)]"
                      )}>
                        {summary.mode.toUpperCase()}
                      </span>
                      <span className="text-[0.607rem] text-[var(--text-tertiary)]">{formatDate(summary.updatedAt)}</span>
                      {summary.status === "exited" && (
                        <span className="text-[0.607rem] text-[var(--text-tertiary)]">· exited</span>
                      )}
                    </div>
                  </div>
                  <span
                    role="button"
                    aria-label="Delete session"
                    onClick={(e) => handleDeleteSession(e, summary.id)}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] transition-all flex-shrink-0"
                  >
                    <Trash2 size={10} />
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── AgentTerminalPane ─────────────────────────────────────────────────────────

export function AgentTerminalPane() {
  const {
    terminalSessions,
    activeSessionId,
    setActiveSession,
    removeTerminalSession,
    persistentPiSessionId,
    activeProjectId,
    fetchPiSessionHistory,
  } = useCairnStore(useShallow((s) => ({
    terminalSessions:       s.terminalSessions,
    activeSessionId:        s.activeSessionId,
    setActiveSession:       s.setActiveSession,
    removeTerminalSession:  s.removeTerminalSession,
    persistentPiSessionId:  s.persistentPiSessionId,
    activeProjectId:        s.activeProjectId,
    fetchPiSessionHistory:  s.fetchPiSessionHistory,
  })));

  const [spawnOpen, setSpawnOpen] = useState(false);

  // Fetch session history on mount and when project changes
  useEffect(() => {
    if (activeProjectId) fetchPiSessionHistory(activeProjectId);
  }, [activeProjectId, fetchPiSessionHistory]);

  const handleClose = useCallback((sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    TerminalManager.delete(sessionId);
    removeTerminalSession(sessionId);
    window.electron?.agent.kill(sessionId).catch(console.error);
  }, [removeTerminalSession]);

  // The persistent pi session (may not be in terminalSessions yet if not loaded)
  const persistentSession = terminalSessions.find((t) => t.sessionId === persistentPiSessionId && t.sessionType === "pi");

  // PTY-only sessions (shown as closeable tabs after the pinned tab)
  const ptySessions = terminalSessions.filter((t) => t.sessionType === "pty");

  // Determine if the pinned tab is active
  const pinnedIsActive = persistentPiSessionId !== null && activeSessionId === persistentPiSessionId;

  return (
    <>
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center border-b border-[var(--border)] overflow-x-auto flex-shrink-0 bg-[var(--surface)]">
        {/* Always-present Cairn Agent pinned tab */}
        <PiAgentTab
          isActive={pinnedIsActive}
          onActivate={() => {
            if (persistentPiSessionId) {
              setActiveSession(persistentPiSessionId);
            }
          }}
        />

        {/* PTY sessions */}
        {ptySessions.map((session) => (
          <TerminalTab
            key={session.sessionId}
            session={session}
            isActive={session.sessionId === activeSessionId}
            onActivate={() => setActiveSession(session.sessionId)}
            onClose={(e) => handleClose(session.sessionId, e)}
          />
        ))}

        {/* New session button */}
        <Tooltip content="New session" side="bottom">
          <button
            onClick={() => setSpawnOpen(true)}
            className="flex-shrink-0 px-2 py-2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors border-r border-[var(--border)]"
          >
            <Plus size={12} />
          </button>
        </Tooltip>
      </div>

      {/* Session content */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-[var(--background)]">
        {/* Pinned pi session content */}
        {persistentSession ? (
          <div className={cn("flex-1 min-h-0 overflow-hidden", !pinnedIsActive && "hidden")}>
            <PiAgentPane session={persistentSession} isActive={pinnedIsActive} />
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-hidden">
            <PiAgentEmptyState />
          </div>
        )}

        {/* PTY sessions */}
        {ptySessions.map((session) => (
          <SessionMount
            key={session.sessionId}
            session={session}
            isActive={session.sessionId === activeSessionId}
          />
        ))}
      </div>
    </div>
    <SpawnAgentModal open={spawnOpen} onClose={() => setSpawnOpen(false)} />
    </>
  );
}

// ── TerminalTab ───────────────────────────────────────────────────────────────

interface TerminalTabProps {
  session: TerminalSession;
  isActive: boolean;
  onActivate: () => void;
  onClose: (e: React.MouseEvent) => void;
}

function TerminalTab({ session, isActive, onActivate, onClose }: TerminalTabProps) {
  return (
    <button
      onClick={onActivate}
      role="tab"
      aria-selected={isActive}
      className={cn(
        "flex items-center gap-1.5 px-3 py-2 text-[0.714rem] whitespace-nowrap border-r border-[var(--border)] transition-colors flex-shrink-0 group",
        isActive
          ? "text-[var(--text-primary)] bg-[var(--background)]"
          : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
      )}
    >
      {/* Session type icon / status dot */}
      {session.sessionType === "pi" ? (
        <MessageSquare
          size={8}
          className={cn(
            "flex-shrink-0",
            session.status === "running" ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]"
          )}
        />
      ) : (
        <CircleDot
          size={8}
          className={cn(
            "flex-shrink-0",
            session.status === "running"
              ? "text-[var(--success,#22c55e)]"
              : "text-[var(--text-tertiary)]"
          )}
        />
      )}

      {/* Label */}
      <span className="max-w-[120px] truncate">{session.taskTitle}</span>
      <span className="text-[var(--text-tertiary)]">{session.agentName}</span>

      {/* Exit code badge */}
      {session.status === "exited" && (
        <span className="text-[0.65rem] text-[var(--text-tertiary)]">
          [{session.exitCode}]
        </span>
      )}

      {/* Close */}
      <Tooltip content="Close session" side="bottom">
        <span
          role="button"
          aria-label={`Close ${session.taskTitle}`}
          onClick={onClose}
          className="ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--surface-2)] transition-all"
        >
          <X size={10} />
        </span>
      </Tooltip>
    </button>
  );
}
