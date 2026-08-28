"use client";

import React, { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { buildSessionRegistry, type SessionSummary } from "@/lib/session-registry";
import { useSessionNavigation } from "./useSessionNavigation";
import { useSessionRunningIds } from "@/hooks/useSessionRunningIds";
import { kindLabel, SessionRow, SessionTypeIcon } from "./SessionRow";

interface SessionBrowserProps {
  activeSessionId: string | null;
  projectId?: string;
  variant?: "dropdown" | "preview" | "project";
  limit?: number;
}

function matchesQuery(session: SessionSummary, query: string): boolean {
  if (!query) return true;
  const value = `${session.title} ${kindLabel(session.kind)}`.toLowerCase();
  return value.includes(query.toLowerCase());
}

function sanitizeAriaId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
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
  const listboxId = useId();

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
        triggerRef.current?.focus({ preventScroll: true });
      }
    };
    // Document Escape always closes and returns focus — the input's own
    // stopPropagation handler is the only clear-first branch, so focus on
    // [role=option] or elsewhere reliably closes the popover.
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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
  }, [open]);

  // Arrow-key navigation inside the listbox (roving tabindex).
  function handleListboxKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return;
    const container = listboxRef.current;
    if (!container) return;
    const options = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
    if (options.length === 0) return;
    const activeEl = document.activeElement as HTMLElement | null;
    const currentIndex = activeEl ? options.indexOf(activeEl) : -1;
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
    const hasActive = !!active;
    return (
      <div role="listbox" aria-label="Recent sessions" aria-orientation="vertical" className="flex flex-col gap-0.5" tabIndex={-1} onKeyDown={handleListboxKeyDown} ref={listboxRef}>
        {previewSessions.length === 0 ? (
          <p className="text-[0.714rem] text-[var(--text-tertiary)]">No sessions yet</p>
        ) : previewSessions.map((session, index) => {
          const selected = active?.id === session.id;
          return (
            <SessionRow
              key={session.id}
              session={session}
              selected={selected}
              running={isRunning(session)}
              tabIndex={selected ? 0 : !hasActive && index === 0 ? 0 : -1}
              onSelect={() => void selectSession(session)}
            />
          );
        })}
      </div>
    );
  }

  function removeSession(event: React.SyntheticEvent, session: SessionSummary) {
    event.stopPropagation();
    const deletedIndex = visibleSessions.findIndex((s) => s.id === session.id);
    const triggerEl = triggerRef.current;
    const doDelete = session.kind === "chat"
      ? deleteThread(session.sourceId)
      : session.kind === "coding"
        ? deleteCodingSessionFromHistory(session.sourceId)
        : Promise.resolve();
    void Promise.resolve(doDelete as unknown as Promise<unknown>).then(() => {
      requestAnimationFrame(() => {
        const container = listboxRef.current;
        if (!container) {
          triggerEl?.focus();
          return;
        }
        const options = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
        if (options.length === 0) {
          // Focus stays logical: back to search or trigger
          if (searchInputRef.current && open) searchInputRef.current.focus();
          else triggerEl?.focus();
          return;
        }
        let nextIndex = deletedIndex;
        if (nextIndex >= options.length) nextIndex = options.length - 1;
        if (nextIndex < 0) nextIndex = 0;
        const toFocus = options[nextIndex];
        if (toFocus) toFocus.focus();
        else triggerEl?.focus();
      });
    }).catch(() => undefined);
  }

  const projectNav = variant === "project";
  const currentKind = projectNav ? "chat" : active?.kind;
  const sanitizedListboxId = sanitizeAriaId(listboxId);
  return (
    <div
      ref={rootRef}
      className={cn("relative", projectNav ? "flex-shrink-0 h-auto" : "flex-1 min-w-0")}
      onBlur={(e) => {
        if (!open) return;
        const related = e.relatedTarget as Node | null;
        if (!related || !e.currentTarget.contains(related)) {
          setOpen(false);
          setQuery("");
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? sanitizedListboxId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          projectNav
            ? "flex items-center gap-2 w-full rounded-md px-2 py-1 text-[0.714rem] text-[var(--text-tertiary)] text-left transition-colors"
            : "group flex w-full min-w-0 items-center justify-between gap-1.5 rounded-md border bg-[var(--surface-2)] px-2 py-1 text-left transition-colors",
          projectNav
            ? open ? "bg-[var(--surface-2)] text-[var(--text-primary)]" : "hover:bg-[var(--surface-2)]"
            : open
              ? "border-[var(--accent)] text-[var(--text-primary)]"
              : "border-[var(--border)] text-[var(--text-primary)] hover:border-[var(--muted)]",
        )}
      >
        <span className={cn("flex items-center gap-1.5 min-w-0 flex-1", projectNav ? "text-[var(--text-tertiary)]" : "text-[var(--accent)]")}>
          <span className="flex-shrink-0">
            <SessionTypeIcon kind={currentKind ?? "chat"} size={projectNav ? 12 : 11} />
          </span>
          <span className="min-w-0 flex-1 text-left leading-tight">
            <span className={cn("block truncate", projectNav ? "" : "text-[0.714rem] font-medium leading-none text-[var(--text-primary)]")}>
              {projectNav ? "Conversations" : active?.title ?? "Sessions"}
            </span>
            {!projectNav && (
              <span className="block truncate text-[0.607rem] leading-none text-[var(--text-tertiary)]">
                {active ? kindLabel(active.kind) : "Choose a session"} · {sessions.length} session{sessions.length === 1 ? "" : "s"}
              </span>
            )}
          </span>
        </span>
        {projectNav ? (
          <>
            <span className="ml-auto text-[0.714rem] text-[var(--text-tertiary)] shrink-0">{sessions.length}</span>
            {open
              ? <ChevronDown size={12} className="text-[var(--text-tertiary)] shrink-0" />
              : <ChevronRight size={12} className="text-[var(--text-tertiary)] shrink-0" />}
          </>
        ) : (
          <ChevronDown
            size={12}
            className={cn(
              "ml-auto flex-shrink-0 text-[var(--text-tertiary)] transition-transform group-hover:text-[var(--text-secondary)]",
              open && "rotate-180 text-[var(--text-secondary)]",
            )}
          />
        )}
      </button>
      <span aria-live="polite" aria-atomic="true" className="sr-only">{runningIds.size > 0 ? `${runningIds.size} running` : ""}</span>

      {open && (
        <div className={cn(
          projectNav
            ? "mt-0.5 ml-2 border-l border-[var(--border)] pl-1.5"
            : "absolute left-0 top-full z-50 mt-1 w-80 min-w-full max-h-72 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg py-1 animate-fade-in flex flex-col overflow-hidden",
        )}>
          <div className={projectNav ? "px-1 pb-1" : "sticky top-0 z-10 bg-[var(--surface)] p-1"}>
            <div className={cn("flex items-center gap-1.5", projectNav ? "rounded-md bg-[var(--surface-2)] px-2 py-1" : "rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1")}>
              <Search size={12} className="text-[var(--text-tertiary)] flex-shrink-0" />
              <input
                ref={searchInputRef}
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    if (query.trim() !== "") {
                      setQuery("");
                    } else {
                      setOpen(false);
                      triggerRef.current?.focus();
                    }
                    return;
                  }
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return;
                    e.preventDefault();
                    const options = listboxRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
                    if (!options || options.length === 0) return;
                    if (e.key === "ArrowDown") options[0]?.focus();
                    else options[options.length - 1]?.focus();
                    return;
                  }
                  // Prevent Radix typeahead from hijacking keystrokes when this
                  // input lives inside a DropdownMenuContent (future portal)
                  // and keep Search typing in-place.
                  if (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete") e.stopPropagation();
                }}
                placeholder="Search sessions"
                className="flex-1 min-w-0 bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
              />
              {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear session search" className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"><X size={11} /></button>}
            </div>
          </div>
          {/* The dropdown menu keeps its section label; the inline sidebar tree
              omits it — the "Conversations" header above already names it. */}
          {!projectNav && (
            <div className="px-2.5 py-1 text-[0.643rem] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
              All sessions
            </div>
          )}
          <div
            ref={listboxRef}
            id={sanitizedListboxId}
            role="listbox"
            aria-label="Sessions"
            aria-orientation="vertical"
            tabIndex={-1}
            onKeyDown={handleListboxKeyDown}
            className={cn("flex-1 min-h-0 overflow-y-auto", projectNav ? "pb-1 space-y-0.5" : "px-1 pb-1 space-y-0.5")}
          >
            {visibleSessions.length === 0 ? (
              <p className="px-2 py-3 text-center text-[0.714rem] text-[var(--text-tertiary)]">No matching sessions</p>
            ) : visibleSessions.map((session, index) => {
              const selected = active?.id === session.id;
              const hasActive = !!active;
              return (
                <SessionRow
                  key={session.id}
                  session={session}
                  selected={selected}
                  running={isRunning(session)}
                  tabIndex={selected ? 0 : !hasActive && index === 0 ? 0 : -1}
                  onSelect={() => void selectSession(session)}
                  onRemove={(event) => removeSession(event, session)}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
