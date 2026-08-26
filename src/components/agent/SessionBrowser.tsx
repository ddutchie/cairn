"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Code2, ChevronDown, ChevronRight, MessageSquare, Search, Terminal, Trash2, X } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn, formatDateCompact } from "@/lib/utils";
import type { SessionKind } from "@/types";
import { buildSessionRegistry, type SessionSummary } from "@/lib/session-registry";
import { useSessionNavigation } from "./useSessionNavigation";
import { useSessionRunningIds } from "@/hooks/useSessionRunningIds";

interface SessionBrowserProps {
  activeSessionId: string | null;
  projectId?: string;
  variant?: "dropdown" | "preview" | "project";
  limit?: number;
}

function kindLabel(kind: SessionKind): string {
  if (kind === "chat") return "Chat";
  if (kind === "coding") return "Coding";
  return "Terminal";
}

function SessionTypeIcon({ kind, size }: { kind: SessionKind; size: number }) {
  if (kind === "chat") return <MessageSquare size={size} />;
  if (kind === "coding") return <Code2 size={size} />;
  return <Terminal size={size} />;
}

function matchesQuery(session: SessionSummary, query: string): boolean {
  if (!query) return true;
  const value = `${session.title} ${kindLabel(session.kind)}`.toLowerCase();
  return value.includes(query.toLowerCase());
}

interface SessionRowProps {
  session: SessionSummary;
  selected: boolean;
  running: boolean;
  onSelect: () => void;
  onRemove?: (event: React.SyntheticEvent) => void;
}

/** One session entry — shared by the sidebar tree and the dropdown menu so both
 *  surfaces stay on the same type scale, spacing, and selection treatment. */
function SessionRow({ session, selected, running, onSelect, onRemove }: SessionRowProps) {
  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    } else if (e.key === "Delete" && selected && onRemove) {
      e.preventDefault();
      onRemove(e);
    }
  }
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      className={cn(
        "group relative flex items-center gap-2 rounded-md border-l-2 px-2 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] cursor-pointer",
        selected
          ? "border-l-[var(--accent)] bg-[var(--accent-dim)]"
          : "border-l-transparent hover:bg-[var(--surface-2)]",
      )}
    >
      <div className="flex items-center gap-2 flex-1 min-w-0 text-left">
        <span className={cn("flex-shrink-0", selected ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]")}>
          <SessionTypeIcon kind={session.kind} size={13} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-[var(--text-primary)]">{session.title}</span>
          <span className="flex items-center gap-1.5 mt-0.5 text-[0.714rem] text-[var(--text-tertiary)]">
            <span>{kindLabel(session.kind)}</span>
            <span aria-hidden>·</span>
            <span>{formatDateCompact(session.updatedAt)}</span>
            {session.mode === "plan" && <span className="text-[var(--warning)]">plan</span>}
            {running && (
              <span className="flex items-center gap-1 text-[var(--accent)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" aria-hidden />
                running
              </span>
            )}
          </span>
        </span>
      </div>
      {onRemove && session.kind !== "terminal" && (
        <button
          type="button"
          tabIndex={selected ? 0 : -1}
          aria-label={`Delete ${kindLabel(session.kind).toLowerCase()} session`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(e);
          }}
          className="flex-shrink-0 grid place-items-center w-6 h-6 rounded opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] focus-visible:text-[var(--danger)] transition-all"
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  );
}

export function SessionBrowser({ activeSessionId, projectId, variant = "dropdown", limit = 5 }: SessionBrowserProps) {
  const {
    chatThreads,
    chatMessages,
    activeChatThreadId,
    activeProjectId,
    codingSessionHistory,
    terminalSessions,
    activeCodingSessionId,
    chatOpen,
    setView,
    toggleChat,
    deleteThread,
    deleteCodingSessionFromHistory,
  } = useCairnStore(useShallow((s) => ({
    chatThreads: s.chatThreads,
    chatMessages: s.chatMessages,
    activeChatThreadId: s.activeChatThreadId,
    activeProjectId: s.activeProjectId,
    codingSessionHistory: s.codingSessionHistory,
    terminalSessions: s.terminalSessions,
    activeCodingSessionId: s.activeCodingSessionId,
    chatOpen: s.chatOpen,
    setView: s.setView,
    toggleChat: s.toggleChat,
    deleteThread: s.deleteThread,
    deleteCodingSessionFromHistory: s.deleteCodingSessionFromHistory,
  })));
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { openSession } = useSessionNavigation();

  // Coalesced polling — one interval for all mounted browsers (sidebar has N
  // expanded projects). Backs off when the document is hidden.
  const liveActive = variant === "preview" || open;
  const runningIds = useSessionRunningIds(liveActive);

  const sessions = useMemo<SessionSummary[]>(() => {
    const scopedProjectId = projectId ?? activeProjectId;
    return buildSessionRegistry({
      chatThreads,
      chatMessages,
      codingSessions: codingSessionHistory,
      terminalSessions,
      projectId: scopedProjectId,
    });
  }, [activeProjectId, chatMessages, chatThreads, codingSessionHistory, projectId, terminalSessions]);

  const visibleSessions = sessions.filter((session) => matchesQuery(session, query.trim()));
  // A session is "selected" only when its surface is genuinely the one on
  // screen. `activeChatThreadId` is auto-selected per project on load, so
  // matching on it alone would light up the most-recent chat of every project
  // even when the chat panel is closed or a different session is open. Gate the
  // chat match on the chat surface actually being the active, open one.
  const chatSurfaceActive = chatOpen && activeSessionId === "chat";
  // The coding pane is on screen when the active tab is the pinned coding
  // session (either the literal id or the "agent" alias).
  const codingSurfaceActive = activeSessionId === "agent" || (activeCodingSessionId !== null && activeSessionId === activeCodingSessionId);
  const active = sessions.find((session) =>
    session.kind === "chat"
      ? chatSurfaceActive && session.sourceId === activeChatThreadId
      : session.kind === "coding"
        ? codingSurfaceActive && session.sourceId === activeCodingSessionId
        : session.sourceId === activeSessionId,
  );

  // A session is genuinely running only if its loop is in the live set. The
  // runtime id for chat sessions is `chat-<threadId>`; coding/terminal use the
  // raw source id.
  const isRunning = (session: SessionSummary): boolean =>
    runningIds.has(session.kind === "chat" ? `chat-${session.sourceId}` : session.sourceId);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (query.trim() !== "") return;
        event.preventDefault();
        setOpen(false);
        setQuery("");
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, query]);

  // Arrow-key navigation inside the listbox (roving tabindex).
  function handleListboxKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const container = listboxRef.current;
    if (!container) return;
    const options = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
    if (options.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const currentIndex = active ? options.indexOf(active) : -1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = currentIndex < options.length - 1 ? currentIndex + 1 : 0;
      options[next]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = currentIndex > 0 ? currentIndex - 1 : options.length - 1;
      options[prev]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      options[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      options[options.length - 1]?.focus();
    }
  }

  async function selectSession(session: SessionSummary) {
    // The project variant is an inline sidebar section, not a transient menu.
    // Keep it expanded so changing sessions does not make navigation jump.
    if (variant !== "project") {
      setOpen(false);
      setQuery("");
    }
    const presentation = variant === "preview" ? "center" : "drawer";
    const opened = await openSession({
      sourceId: session.sourceId,
      kind: session.kind,
      projectId: session.projectId,
    }, presentation);
    if (!opened) return;
    if (variant === "preview") {
      setView("chat");
    } else if (!chatOpen) {
      toggleChat();
    }
  }

  if (variant === "preview") {
    const previewSessions = visibleSessions.slice(0, limit);
    return (
      <div role="listbox" aria-label="Recent sessions" className="flex flex-col gap-0.5" tabIndex={-1} onKeyDown={handleListboxKeyDown} ref={listboxRef}>
        {previewSessions.length === 0 ? (
          <p className="text-[0.714rem] text-[var(--text-tertiary)]">No sessions yet</p>
        ) : previewSessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            selected={active?.id === session.id}
            running={isRunning(session)}
            onSelect={() => void selectSession(session)}
          />
        ))}
      </div>
    );
  }

  function removeSession(event: React.SyntheticEvent, session: SessionSummary) {
    event.stopPropagation();
    if (session.kind === "chat") {
      void deleteThread(session.sourceId);
    } else if (session.kind === "coding") {
      void deleteCodingSessionFromHistory(session.sourceId);
    }
  }

  const projectNav = variant === "project";
  const currentKind = projectNav ? "chat" : active?.kind;
  return (
    <div ref={rootRef} className={cn("relative", projectNav ? "flex-shrink-0 h-auto" : "flex-1 min-w-0 h-full")}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          projectNav
            ? "flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-xs text-[var(--text-tertiary)] text-left transition-colors"
            : "group flex items-center gap-2 px-3 h-full w-full border-r border-[var(--border)] text-left transition-colors",
          open ? "bg-[var(--surface-2)] text-[var(--text-primary)]" : "hover:bg-[var(--surface-2)]",
        )}
      >
        <span className={cn("flex-shrink-0", projectNav ? "text-[var(--text-tertiary)]" : "text-[var(--accent)]")}>
          <SessionTypeIcon kind={currentKind ?? "chat"} size={projectNav ? 13 : 12} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate", projectNav ? "" : "text-[0.714rem] font-semibold text-[var(--text-primary)]")}>
            {projectNav ? "Conversations" : active?.title ?? "Sessions"}
          </span>
          {!projectNav && (
            <span className="block text-[0.607rem] text-[var(--text-tertiary)]">
              {active ? kindLabel(active.kind) : "Choose a session"} · {sessions.length} session{sessions.length === 1 ? "" : "s"}
            </span>
          )}
        </span>
        {projectNav ? (
          <>
            <span className="ml-auto text-[0.714rem] text-[var(--text-tertiary)]">{sessions.length}</span>
            {open
              ? <ChevronDown size={12} className="text-[var(--text-tertiary)]" />
              : <ChevronRight size={12} className="text-[var(--text-tertiary)]" />}
          </>
        ) : (
          <ChevronDown
            size={14}
            className={cn(
              "ml-auto flex-shrink-0 text-[var(--text-tertiary)] transition-transform group-hover:text-[var(--text-secondary)]",
              open && "rotate-180 text-[var(--text-secondary)]",
            )}
          />
        )}
      </button>

      {open && (
        <div className={cn(
          projectNav
            ? "mt-0.5 ml-2 border-l border-[var(--border)] pl-1.5"
            : "absolute left-0 top-full z-50 mt-0.5 w-80 min-w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl overflow-hidden",
        )}>
          <div className={projectNav ? "px-1 pb-1" : "px-3 py-2 border-b border-[var(--border)]"}>
            <div className={cn("flex items-center gap-1.5", projectNav && "rounded-md bg-[var(--surface-2)] px-2 py-1.5")}>
              <Search size={12} className="text-[var(--text-tertiary)]" />
              <input
                ref={searchInputRef}
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    if (query.trim() !== "") {
                      e.stopPropagation();
                      setQuery("");
                    } else {
                      setOpen(false);
                      triggerRef.current?.focus();
                    }
                  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    const options = listboxRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
                    if (!options || options.length === 0) return;
                    if (e.key === "ArrowDown") options[0]?.focus();
                    else options[options.length - 1]?.focus();
                  }
                }}
                placeholder="Search sessions"
                className="flex-1 min-w-0 bg-transparent text-[0.714rem] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
              />
              {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear session search" className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"><X size={11} /></button>}
            </div>
          </div>
          {/* The dropdown menu keeps its section label; the inline sidebar tree
              omits it — the "Conversations" header above already names it. */}
          {!projectNav && (
            <div className="px-3 py-1.5 border-b border-[var(--border)] text-[0.607rem] uppercase tracking-wider text-[var(--text-tertiary)]">
              All sessions
            </div>
          )}
          <div
            ref={listboxRef}
            role="listbox"
            aria-label="Sessions"
            tabIndex={-1}
            onKeyDown={handleListboxKeyDown}
            className={cn("max-h-80 overflow-y-auto", projectNav && "pb-1 space-y-0.5")}
          >
            {visibleSessions.length === 0 ? (
              <p className="px-2 py-3 text-center text-[0.714rem] text-[var(--text-tertiary)]">No matching sessions</p>
            ) : visibleSessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                selected={active?.id === session.id}
                running={isRunning(session)}
                onSelect={() => void selectSession(session)}
                onRemove={(event) => removeSession(event, session)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
