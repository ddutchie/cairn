"use client";

import React, { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { isView } from "@/lib/views";
import { buildSessionRegistry, type SessionSummary } from "@/lib/session-registry";
import { useSessionNavigation } from "./useSessionNavigation";
import { useSessionRunningIds } from "@/hooks/useSessionRunningIds";
import { kindLabel, SessionRow, SessionTypeIcon } from "./SessionRow";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FOCUS_RING } from "@/components/ui/button";

interface SessionBrowserProps {
  activeSessionId: string | null;
  projectId?: string;
  variant?: "dropdown" | "preview" | "project";
  limit?: number;
  /** When true, render only the list (no trigger pill) — used inside a parent collapsible section. */
  inline?: boolean;
}

function matchesQuery(session: SessionSummary, query: string): boolean {
  if (!query) return true;
  const value = `${session.title} ${kindLabel(session.kind)}`.toLowerCase();
  return value.includes(query.toLowerCase());
}

function sanitizeAriaId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function SessionBrowser({ activeSessionId, projectId, variant = "dropdown", limit = 5, inline = false }: SessionBrowserProps) {
  const {
    chatThreads,
    chatMessages,
    activeChatThreadId,
    activeProjectId,
    activeWorkspaceId,
    projects,
    codingSessionHistory,
    terminalSessions,
    activeCodingSessionId,
    chatOpen,
    sessionPresentation,
    activeView,
    setView,
    toggleChat,
    deleteThread,
    deleteCodingSessionFromHistory,
  } = useCairnStore(useShallow((s) => ({
    chatThreads: s.chatThreads,
    chatMessages: s.chatMessages,
    activeChatThreadId: s.activeChatThreadId,
    activeProjectId: s.activeProjectId,
    activeWorkspaceId: s.activeWorkspaceId,
    projects: s.projects,
    codingSessionHistory: s.codingSessionHistory,
    terminalSessions: s.terminalSessions,
    activeCodingSessionId: s.activeCodingSessionId,
    chatOpen: s.chatOpen,
    sessionPresentation: s.sessionPresentation,
    activeView: s.activeView,
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

  // The dropdown also lists the workspace's other projects, grouped under their
  // names, so a thread from another project is one click away instead of
  // silently missing. Built only while the dropdown is open.
  const scopedProjectId = projectId ?? activeProjectId;
  const otherGroups = useMemo(() => {
    if (variant !== "dropdown" || !open) return [];
    return projects
      .filter((p) => p.workspaceId === activeWorkspaceId && p.id !== scopedProjectId)
      .map((p) => ({
        id: p.id,
        name: p.name,
        sessions: buildSessionRegistry({ chatThreads, chatMessages, codingSessions: codingSessionHistory, terminalSessions, projectId: p.id }),
      }))
      .filter((g) => g.sessions.length > 0);
  }, [variant, open, projects, activeWorkspaceId, scopedProjectId, chatThreads, chatMessages, codingSessionHistory, terminalSessions]);
  const currentProjectName = projects.find((p) => p.id === scopedProjectId)?.name;
  const groups = [
    { id: scopedProjectId ?? "_", name: currentProjectName, sessions: visibleSessions },
    ...otherGroups.map((g) => ({ ...g, sessions: g.sessions.filter((session) => matchesQuery(session, query.trim())) })),
  ].filter((g, i) => i === 0 || g.sessions.length > 0);
  const listedSessions = groups.flatMap((g) => g.sessions);
  // A session is "selected" only when its surface is genuinely the one on
  // screen. `activeChatThreadId` is auto-selected per project on load, so
  // matching on it alone would light up the most-recent chat of every project
  // even when the chat panel is closed or a different session is open. Gate the
  // chat match on the chat surface actually being the active, open one — the
  // drawer when it's open, or the centred chat view (which ignores `chatOpen`).
  const chatSurfaceVisible = chatOpen || (sessionPresentation === "center" && isView(activeView, "chat"));
  const chatSurfaceActive = chatSurfaceVisible && activeSessionId === "chat";
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
    if (!open || variant !== "project") return;
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
  }, [open, variant]);

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
          <p className="text-xs text-[var(--text-tertiary)]">No sessions yet</p>
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

  const triggerId = `${sanitizeAriaId(listboxId)}-trigger`;
  const sanitizedListboxId = sanitizeAriaId(listboxId);

  function removeSession(event: React.SyntheticEvent, session: SessionSummary) {
    event.stopPropagation();
    const deletedIndex = listedSessions.findIndex((s) => s.id === session.id);
    const doDelete = session.kind === "chat"
      ? deleteThread(session.sourceId)
      : session.kind === "coding"
        ? deleteCodingSessionFromHistory(session.sourceId)
        : Promise.resolve();
    void Promise.resolve(doDelete as unknown as Promise<unknown>).then(() => {
      // Looked up by id rather than through refs: this runs from row buttons,
      // the Delete key and the context menu alike.
      requestAnimationFrame(() => {
        const triggerEl = document.getElementById(triggerId);
        const container = document.getElementById(sanitizedListboxId);
        const options = container ? Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')) : [];
        if (options.length === 0) {
          // Nothing left to land on: back to the search field, else the trigger.
          const search = container?.parentElement?.querySelector<HTMLInputElement>("input");
          if (search) search.focus();
          else triggerEl?.focus();
          return;
        }
        const nextIndex = Math.min(Math.max(deletedIndex, 0), options.length - 1);
        options[nextIndex].focus();
      });
    }).catch(() => undefined);
  }

  const projectNav = variant === "project";

  // Inline mode — used when the parent already provides a collapsible header
  // (e.g. DockSidebar Conversations). Render only the search + list, no trigger pill,
  // so we don't get a double "Conversations" label.
  if (inline) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5 rounded-md bg-[var(--surface-2)] px-2 py-1">
          <Search size={12} className="text-[var(--text-tertiary)] flex-shrink-0" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query.trim() !== "") {
                e.preventDefault();
                setQuery("");
                return;
              }
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return;
                e.preventDefault();
                const options = listboxRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
                if (!options || options.length === 0) return;
                if (e.key === "ArrowDown") options[0]?.focus();
                else options[options.length - 1]?.focus();
              }
            }}
            placeholder="Search conversations"
            className="flex-1 min-w-0 bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
          />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"><X size={11} /></button>}
        </div>
        <div
          ref={listboxRef}
          id={sanitizedListboxId}
          role="listbox"
          aria-label="Conversations"
          aria-orientation="vertical"
          tabIndex={-1}
          onKeyDown={handleListboxKeyDown}
          className="flex-1 min-h-0 overflow-y-auto pb-1 space-y-0.5"
        >
          {visibleSessions.length === 0 ? (
            <p className="px-2 py-2 text-center text-xs text-[var(--text-tertiary)]">No conversations yet</p>
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
                compact
              />
            );
          })}
        </div>
      </div>
    );
  }

  if (!projectNav) {
    // Roving focus enters on the selected row, or the first row when none is.
    const entryId = active?.id ?? listedSessions[0]?.id;
    return (
      <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            id={triggerId}
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={active ? `Session: ${active.title}. Switch session` : "Choose a session"}
            title={active?.title}
            className={cn(
              "flex w-full min-w-0 items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs text-left transition-colors hover:bg-[var(--surface-2)]",
              FOCUS_RING,
              open && "bg-[var(--surface-2)]",
            )}
          >
            <span className="flex-shrink-0 text-[var(--text-tertiary)]">
              <SessionTypeIcon kind={active?.kind ?? "chat"} size={12} />
            </span>
            <span className={cn("min-w-0 flex-1 truncate", active ? "text-[var(--text-primary)]" : "text-[var(--text-tertiary)]")}>
              {active?.title ?? "Sessions"}
            </span>
            {runningIds.size > 0 && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--accent)]" aria-hidden />}
            <ChevronDown size={12} className={cn("flex-shrink-0 text-[var(--text-tertiary)] transition-transform", open && "rotate-180")} />
          </button>
        </PopoverTrigger>
        <span aria-live="polite" aria-atomic="true" className="sr-only">{runningIds.size > 0 ? `${runningIds.size} running` : ""}</span>
        <PopoverContent
          align="start"
          matchTriggerWidth
          className="flex max-h-96 min-w-[20rem] flex-col overflow-hidden"
          onOpenAutoFocus={(e) => { e.preventDefault(); searchInputRef.current?.focus(); }}
          onEscapeKeyDown={(e) => {
            // First Escape clears the search; the next one closes.
            if (!query) return;
            e.preventDefault();
            setQuery("");
          }}
        >
          <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-2">
            <Search size={12} className="flex-shrink-0 text-[var(--text-tertiary)]" />
            <input
              ref={searchInputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return;
                  e.preventDefault();
                  const options = listboxRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
                  if (!options || options.length === 0) return;
                  if (e.key === "ArrowDown") options[0]?.focus();
                  else options[options.length - 1]?.focus();
                }
              }}
              aria-label="Search sessions"
              placeholder="Search sessions"
              className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
            />
          </div>
          <div
            ref={listboxRef}
            id={sanitizedListboxId}
            role="listbox"
            aria-label="Sessions"
            aria-orientation="vertical"
            tabIndex={-1}
            onKeyDown={handleListboxKeyDown}
            className="min-h-0 flex-1 overflow-y-auto p-1"
          >
            {listedSessions.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-[var(--text-tertiary)]">{query ? "No matching sessions" : "No sessions yet"}</p>
            ) : groups.map((g) => g.sessions.length === 0 ? null : (
              <div key={g.id} role="group" aria-label={g.name ?? "This project"} className="space-y-0.5 [&+&]:mt-1">
                {/* Name the groups only when there's more than one */}
                {groups.length > 1 && g.name && (
                  <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-[var(--text-tertiary)] truncate">{g.name}</div>
                )}
                {g.sessions.map((session) => {
                  const selected = active?.id === session.id;
                  return (
                    <SessionRow
                      key={session.id}
                      session={session}
                      selected={selected}
                      running={isRunning(session)}
                      tabIndex={session.id === entryId ? 0 : -1}
                      onSelect={() => void selectSession(session)}
                      onRemove={(event) => removeSession(event, session)}
                      compact
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  // Project variant: an inline expanding tree ("Conversations") rather than a
  // floating menu.
  return (
    <div
      ref={rootRef}
      className="relative flex-shrink-0 h-auto"
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
        id={triggerId}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? sanitizedListboxId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex items-center gap-2 w-full rounded-md px-2 py-1 text-xs text-[var(--text-tertiary)] text-left transition-colors",
          open ? "bg-[var(--surface-2)] text-[var(--text-primary)]" : "hover:bg-[var(--surface-2)]",
        )}
      >
        <span className="flex items-center gap-1.5 min-w-0 flex-1 text-[var(--text-tertiary)]">
          <span className="flex-shrink-0">
            <SessionTypeIcon kind="chat" size={12} />
          </span>
          <span className="min-w-0 flex-1 truncate text-left leading-tight">Conversations</span>
        </span>
        <span className="ml-auto text-xs text-[var(--text-tertiary)] shrink-0">{sessions.length}</span>
        {open
          ? <ChevronDown size={12} className="text-[var(--text-tertiary)] shrink-0" />
          : <ChevronRight size={12} className="text-[var(--text-tertiary)] shrink-0" />}
      </button>
      <span aria-live="polite" aria-atomic="true" className="sr-only">{runningIds.size > 0 ? `${runningIds.size} running` : ""}</span>

      {open && (
        <div className="mt-0.5 ml-2 border-l border-[var(--border)] pl-1.5">
          <div className="px-1 pb-1">
            <div className="flex items-center gap-1.5 rounded-md bg-[var(--surface-2)] px-2 py-1">
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
                  }
                }}
                placeholder="Search sessions"
                className="flex-1 min-w-0 bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
              />
              {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear session search" className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"><X size={11} /></button>}
            </div>
          </div>
          <div
            ref={listboxRef}
            id={sanitizedListboxId}
            role="listbox"
            aria-label="Sessions"
            aria-orientation="vertical"
            tabIndex={-1}
            onKeyDown={handleListboxKeyDown}
            className="flex-1 min-h-0 overflow-y-auto pb-1 space-y-0.5"
          >
            {visibleSessions.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-[var(--text-tertiary)]">No matching sessions</p>
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
                  compact
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
