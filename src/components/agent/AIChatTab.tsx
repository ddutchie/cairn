"use client";

import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { X, ChevronDown, MessageSquare, History, Pencil } from "lucide-react";
import { useCairnStore } from "@/store";
import { cn, formatRelative } from "@/lib/utils";

interface AIChatTabProps {
  isActive: boolean;
  onActivate: () => void;
}

export function AIChatTab({ isActive, onActivate }: AIChatTabProps) {
  const {
    chatThreads, chatMessages, projectedTitles, activeProjectId, activeWorkspaceId,
    activeChatThreadId, setActiveChatThreadId,
    createNewThread, deleteThread, renameThread, clearAllThreads,
  } = useCairnStore(useShallow((s) => ({
    chatThreads: s.chatThreads,
    chatMessages: s.chatMessages,
    projectedTitles: (s as unknown as { projectedTitles?: Record<string, string | null> }).projectedTitles ?? {},
    activeProjectId: s.activeProjectId,
    activeWorkspaceId: s.activeWorkspaceId,
    activeChatThreadId: s.activeChatThreadId,
    setActiveChatThreadId: s.setActiveChatThreadId,
    createNewThread: s.createNewThread,
    deleteThread: s.deleteThread,
    renameThread: s.renameThread,
    clearAllThreads: (s as unknown as { clearAllThreads?: (ws: string, proj?: string) => Promise<void> }).clearAllThreads,
  })));

  // Live title projection: dsh's session/title fold broadcasts on session:projection
  // kind:'title' (chat-* only). Keep the store's projectedTitles map warm so the
  // dropdown shows the LLM auto-title immediately without a reload.
  useEffect(() => {
    const electron = window.electron as unknown as { session?: { onProjection: (cb: (p: { kind: string; sessionId: string; data: { title?: string | null } }) => void) => () => void } } | undefined;
    if (!electron?.session?.onProjection) return;
    const unsub = electron.session.onProjection((proj) => {
      if (proj.kind !== "title" || !proj.sessionId.startsWith("chat-")) return;
      const threadId = proj.sessionId.slice(5);
      const title = (proj.data as { title?: string | null }).title ?? null;
      useCairnStore.getState().setProjectedTitle(threadId, title);
    });
    return () => { try { unsub(); } catch {} };
  }, []);

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  const projectThreads = chatThreads
    .filter((t) => t.projectId === activeProjectId)
    .sort((a, b) => {
      const aHas = chatMessages.some((m) => m.threadId === a.id);
      const bHas = chatMessages.some((m) => m.threadId === b.id);
      if (aHas !== bHas) return bHas ? 1 : -1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    })
    .slice(0, 15);

  useEffect(() => {
    if (!dropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setRenamingId(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [dropdownOpen]);

  function handleSwitchThread(threadId: string) {
    console.log("[AIChatTab] handleSwitchThread", { from: activeChatThreadId, to: threadId, projectThreads: projectThreads.map((t) => t.id) });
    setActiveChatThreadId(threadId);
    setDropdownOpen(false);
    setRenamingId(null);
    onActivate();
  }

  function handleDeleteThread(e: React.MouseEvent, threadId: string) {
    e.stopPropagation();
    deleteThread(threadId);
    if (activeChatThreadId === threadId && activeWorkspaceId) {
      const next = createNewThread(activeWorkspaceId, activeProjectId ?? undefined);
      setActiveChatThreadId(next.id);
    }
  }

  async function handleClearAll(e: React.MouseEvent) {
    e.stopPropagation();
    if (!activeWorkspaceId) return;
    const count = chatThreads.filter((t) => t.workspaceId === activeWorkspaceId && (!activeProjectId || t.projectId === activeProjectId)).length;
    if (count === 0) return;
    if (!confirm(`Clear all ${count} chat threads for this ${activeProjectId ? "project" : "workspace"}? This cannot be undone.`)) return;
    console.log("[AIChatTab] clearAll", { ws: activeWorkspaceId, proj: activeProjectId, count });
    if (clearAllThreads) {
      await clearAllThreads(activeWorkspaceId, activeProjectId ?? undefined);
    } else {
      // Fallback: delete one by one
      for (const t of chatThreads.filter((t) => t.workspaceId === activeWorkspaceId && (!activeProjectId || t.projectId === activeProjectId))) {
        deleteThread(t.id);
      }
      if (activeWorkspaceId) {
        const next = createNewThread(activeWorkspaceId, activeProjectId ?? undefined);
        setActiveChatThreadId(next.id);
      }
    }
    setDropdownOpen(false);
  }

  return (
    <div className="relative flex-shrink-0 h-full" ref={dropdownRef}>
      <button
        onClick={onActivate}
        role="tab"
        aria-selected={isActive}
        className={cn(
          "flex items-center gap-1.5 px-3 h-full text-xs font-semibold whitespace-nowrap border-r border-[var(--border)] transition-colors flex-shrink-0",
          isActive
            ? "text-[var(--text-primary)] bg-[var(--background)]"
            : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
        )}
      >
        <MessageSquare size={11} className={cn("flex-shrink-0", isActive ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]")} />
        <span>AI Chat</span>
        {projectThreads.length > 1 && (
          <span
            role="button"
            aria-label="Chat thread history"
            onClick={(e) => { e.stopPropagation(); setDropdownOpen((v) => !v); }}
            className={cn(
              "ml-0.5 p-0.5 rounded transition-colors hover:bg-[var(--surface-2)]",
              dropdownOpen ? "text-[var(--text-primary)]" : "text-[var(--text-tertiary)]"
            )}
          >
            <ChevronDown size={10} />
          </span>
        )}
      </button>

      {dropdownOpen && (
        <div className="absolute left-0 top-full z-50 mt-0.5 w-72 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl overflow-hidden">
          <div className="px-3 py-2 border-b border-[var(--border)]">
            <div className="flex items-center gap-1.5">
              <History size={10} className="text-[var(--text-tertiary)]" />
              <span className="text-[0.643rem] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Chat threads</span>
            </div>
          </div>
          {projectThreads.length > 1 && (
            <div className="px-3 py-1.5 border-b border-[var(--border)] flex justify-end">
              <button
                onClick={handleClearAll}
                className="text-[0.643rem] font-medium text-[var(--text-tertiary)] hover:text-[var(--danger)] flex items-center gap-1 transition-colors"
                title="Clear all threads for this project"
              >
                <X size={10} /> Clear all ({projectThreads.length})
              </button>
            </div>
          )}
          <div className="max-h-72 overflow-y-auto">
            {projectThreads.map((t) => {
              const firstMsg = chatMessages.find((m) => m.threadId === t.id && m.role === "user");
              const msgCount = chatMessages.filter((m) => m.threadId === t.id).length;
              const isActiveThread = t.id === activeChatThreadId;
              const displayTitle = projectedTitles[t.id] ?? t.title ?? (firstMsg?.content.slice(0, 50) ?? "New thread");
              const needsEllipsis = !(projectedTitles[t.id] ?? t.title) && (firstMsg?.content.length ?? 0) > 50;
              return (
                <div
                  key={t.id}
                  className={cn(
                    "group flex items-center border-b border-[var(--border)] last:border-0 transition-colors",
                    isActiveThread ? "bg-[var(--accent-dim)]" : "hover:bg-[var(--surface-2)]"
                  )}
                >
                  <button
                    onClick={() => handleSwitchThread(t.id)}
                    className="flex-1 text-left px-3 py-2 flex flex-col gap-0.5 min-w-0"
                  >
                    {renamingId === t.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={() => { renameThread(t.id, renameValue); setRenamingId(null); }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { renameThread(t.id, renameValue); setRenamingId(null); }
                          if (e.key === "Escape") setRenamingId(null);
                          e.stopPropagation();
                        }}
                        className="w-full bg-transparent text-[0.786rem] font-medium text-[var(--accent)] outline-none border-b border-[var(--accent)]"
                      />
                    ) : (
                      <span className={cn("text-[0.714rem] truncate font-medium flex items-center gap-1", isActiveThread ? "text-[var(--accent)]" : "text-[var(--text-primary)]")}>
                        <span className="truncate">{displayTitle}{needsEllipsis ? "…" : ""}</span>
                        {msgCount > 0 && <span className="text-[0.607rem] px-1 py-0.5 rounded bg-[var(--surface-3)] text-[var(--text-tertiary)] flex-shrink-0">{msgCount}</span>}
                      </span>
                    )}
                    <span className="text-[0.607rem] text-[var(--text-tertiary)]">{formatRelative(t.updatedAt)} {msgCount > 0 ? `· ${msgCount} msgs` : "· empty"}</span>
                  </button>
                  <div className="opacity-0 group-hover:opacity-100 flex items-center flex-shrink-0 mr-1.5 gap-0.5 transition-all">
                    <button
                      onClick={(e) => { e.stopPropagation(); setRenamingId(t.id); setRenameValue(projectedTitles[t.id] ?? t.title ?? firstMsg?.content.slice(0, 50) ?? ""); }}
                      className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
                      title="Rename thread"
                    >
                      <Pencil size={10} />
                    </button>
                    <button
                      onClick={(e) => handleDeleteThread(e, t.id)}
                      className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] transition-colors"
                      title="Delete thread"
                    >
                      <X size={10} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
