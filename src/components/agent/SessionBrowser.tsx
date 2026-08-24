"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Code2, ChevronDown, ChevronRight, MessageSquare, Search, Terminal, Trash2, X } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn, formatDateCompact } from "@/lib/utils";
import type { SessionKind } from "@/types";
import { buildSessionRegistry, type SessionSummary } from "@/lib/session-registry";
import { useSessionNavigation } from "./useSessionNavigation";

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

function kindIcon(kind: SessionKind) {
  if (kind === "chat") return MessageSquare;
  if (kind === "coding") return Code2;
  return Terminal;
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
  const { openSession } = useSessionNavigation();

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
  const active = sessions.find((session) =>
    session.kind === "chat"
      ? activeSessionId === "chat" && session.sourceId === activeChatThreadId
      : session.kind === "coding"
        ? session.sourceId === activeCodingSessionId
        : session.sourceId === activeSessionId,
  );

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function selectSession(session: SessionSummary) {
    setOpen(false);
    setQuery("");
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
      <div className="flex flex-col gap-1">
        {previewSessions.length === 0 ? (
          <p className="text-[0.714rem] text-[var(--text-tertiary)]">No sessions yet</p>
        ) : previewSessions.map((session) => {
          const Icon = kindIcon(session.kind);
          const selected = active?.id === session.id;
          return (
            <button key={session.id} type="button" onClick={() => void selectSession(session)} className={cn(
              "flex items-center gap-2 w-full rounded-lg px-2.5 py-2 text-left transition-colors",
              selected ? "bg-[var(--accent-dim)]" : "hover:bg-[var(--surface-2)]",
            )}>
              <Icon size={12} className={cn("flex-shrink-0", session.kind === "coding" ? "text-[var(--warning)]" : "text-[var(--accent)]")} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.714rem] text-[var(--text-primary)]">{session.title}</span>
                <span className="block text-[0.607rem] text-[var(--text-tertiary)]">{kindLabel(session.kind)} · {formatDateCompact(session.updatedAt)}</span>
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  function removeSession(event: ReactMouseEvent, session: SessionSummary) {
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
    <div ref={rootRef} className={cn("relative flex-shrink-0", projectNav ? "h-auto" : "h-full")}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          projectNav
            ? "flex items-center gap-1.5 w-full rounded px-1.5 py-1 text-[0.786rem] text-[var(--text-tertiary)] text-left transition-colors"
            : "flex items-center gap-2 px-3 h-full min-w-44 max-w-72 border-r border-[var(--border)] text-left transition-colors",
          open ? "bg-[var(--surface-2)] text-[var(--text-primary)]" : "hover:bg-[var(--surface-2)]",
        )}
      >
        <span className={cn("flex-shrink-0", projectNav ? "text-[var(--text-tertiary)]" : "text-[var(--accent)]")}>
          <SessionTypeIcon kind={currentKind ?? "chat"} size={projectNav ? 11 : 12} />
        </span>
        <span className="min-w-0 flex-1">
            <span className={cn("block truncate", projectNav ? "text-[var(--text-tertiary)]" : "text-[0.714rem] font-semibold text-[var(--text-primary)]")}>
            {projectNav ? "Conversations" : active?.title ?? "Sessions"}
          </span>
          {!projectNav && active && <span className="block text-[0.607rem] text-[var(--text-tertiary)]">{kindLabel(active.kind)}</span>}
        </span>
        <span className="ml-auto text-[0.607rem] text-[var(--text-tertiary)]">{sessions.length}</span>
        {projectNav && (open
          ? <ChevronDown size={11} className="text-[var(--text-tertiary)]" />
          : <ChevronRight size={11} className="text-[var(--text-tertiary)]" />)}
      </button>

      {open && (
        <div className={cn(
          projectNav
            ? "mt-1 ml-2 border-l border-[var(--border)] pl-1.5"
            : "absolute left-0 top-full z-50 mt-0.5 w-80 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl overflow-hidden",
        )}>
          <div className={projectNav ? "px-1.5 py-1" : "px-3 py-2 border-b border-[var(--border)]"}>
            <div className="flex items-center gap-1.5">
              <Search size={11} className="text-[var(--text-tertiary)]" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search sessions"
                className="flex-1 min-w-0 bg-transparent text-[0.714rem] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
              />
              {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear session search"><X size={11} /></button>}
            </div>
          </div>
          <div className={cn(
            "text-[0.607rem] uppercase tracking-wider text-[var(--text-tertiary)]",
            projectNav ? "px-1.5 py-1" : "px-3 py-1.5 border-b border-[var(--border)]",
          )}>
            All sessions
          </div>
          <div className={cn("max-h-80 overflow-y-auto", projectNav && "px-1")}>
            {visibleSessions.length === 0 ? (
              <p className="px-2 py-3 text-center text-[0.714rem] text-[var(--text-tertiary)]">No matching sessions</p>
            ) : visibleSessions.map((session) => {
              const Icon = kindIcon(session.kind);
              const selected = active?.id === session.id;
              return (
                <div key={session.id} role="option" aria-selected={selected} className={cn(
                  "group flex items-center gap-2 rounded-md border-b border-[var(--border-subtle)] last:border-0",
                  projectNav ? "px-1.5 py-1.5" : "px-3 py-2",
                  selected ? "bg-[var(--accent-dim)]" : "hover:bg-[var(--surface-2)]",
                )}>
                  <button type="button" onClick={() => void selectSession(session)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                    <Icon size={projectNav ? 13 : 12} className={cn(
                      "flex-shrink-0",
                      session.kind === "chat" ? "text-[var(--success)]" : session.kind === "coding" ? "text-[var(--warning)]" : "text-[var(--info)]",
                    )} />
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-[var(--text-primary)]", projectNav ? "text-[0.786rem]" : "text-[0.714rem]")}>{session.title}</span>
                      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 mt-0.5 text-[0.607rem] text-[var(--text-tertiary)]">
                        <span>{kindLabel(session.kind)}</span>
                        <span>·</span>
                        <span>{formatDateCompact(session.updatedAt)}</span>
                        {session.messageCount ? <><span>·</span><span>{session.messageCount} msgs</span></> : null}
                        {session.mode === "plan" && <span className="text-[var(--warning)]">· plan</span>}
                        {session.status === "running" && <span className="text-[var(--accent)]">· active</span>}
                      </span>
                    </span>
                  </button>
                  {session.kind !== "terminal" && (
                    <button type="button" aria-label={`Delete ${kindLabel(session.kind).toLowerCase()} session`} onClick={(event) => removeSession(event, session)} className="opacity-0 group-hover:opacity-100 p-1 text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-all">
                      <Trash2 size={10} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
