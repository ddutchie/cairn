"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftFromLine, ChevronDown, ChevronRight, Code2, MessageSquare, PanelLeftClose, PanelLeftOpen, Terminal } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn, formatDateCompact } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { ConversationPane } from "@/components/conversation/ConversationPane";
import type { ConversationMessage } from "@/components/conversation/conversation-message";
import { type ChatPopoutPayload, type SessionPopoutProfile } from "../../../shared/agent/chat-popout";
import { normalizeSessionMessages, applyApprovalProjection } from "@/components/conversation/conversation-session";
import { useSessionConversation } from "@/hooks/useSessionConversation";
import { useSessionRunningIds } from "@/hooks/useSessionRunningIds";
import { buildSessionRegistry, type SessionSummary } from "@/lib/session-registry";
import type { SessionKind } from "@/types";

type Props = ChatPopoutPayload & { onPopIn: () => void };

/** The session the popout is currently bound to. Starts from the handoff and
 *  changes as the user picks another project/session in the left panel. */
interface PopoutSelection {
  sessionId: string;
  profile: SessionPopoutProfile;
  activeProjectId: string | null;
  workspaceId: string | null;
  cwd: string | null;
}

function SessionTypeIcon({ kind, size }: { kind: SessionKind; size: number }) {
  if (kind === "chat") return <MessageSquare size={size} />;
  if (kind === "coding") return <Code2 size={size} />;
  return <Terminal size={size} />;
}

function kindLabel(kind: SessionKind): string {
  if (kind === "chat") return "Chat";
  if (kind === "coding") return "Coding";
  return "Terminal";
}

/** Map a registry session to the profile/runtime shape the popout pane binds to. */
function toSelection(session: SessionSummary, workspaceId: string | null): PopoutSelection {
  return {
    sessionId: session.kind === "chat" ? `chat-${session.sourceId}` : session.sourceId,
    // Terminal sessions have no dedicated runtime profile — they are external PTYs.
    // Map them to "chat" so the popout still has a valid session surface (the
    // terminal itself lives in the main window; the popout shows the chat pane).
    profile: session.kind === "coding" ? "coding" : "chat",
    activeProjectId: session.projectId || null,
    workspaceId,
    cwd: null,
  };
}

export function SessionPopoutView({ sessionId, activeProjectId, profile, workspaceId, cwd, onPopIn }: Props) {
  const { projects, workspaces, chatThreads, chatMessages, codingSessionHistory, terminalSessions, fetchCodingSessionHistoryForProjects, loadChatFromDb } = useCairnStore(useShallow((s) => ({
    projects: s.projects,
    workspaces: s.workspaces,
    chatThreads: s.chatThreads,
    chatMessages: s.chatMessages,
    codingSessionHistory: s.codingSessionHistory,
    terminalSessions: s.terminalSessions,
    fetchCodingSessionHistoryForProjects: s.fetchCodingSessionHistoryForProjects,
    loadChatFromDb: s.loadChatFromDb,
  })));

  const [selection, setSelection] = useState<PopoutSelection>({ sessionId, profile, activeProjectId, workspaceId, cwd });
  const [browserOpen, setBrowserOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(activeProjectId ? [activeProjectId] : []));

  // Keep selection in sync when the handoff updates via chat:sessionUpdated (C2 live push).
  useEffect(() => {
    setSelection({ sessionId, profile, activeProjectId, workspaceId, cwd });
  }, [sessionId, profile, activeProjectId, workspaceId, cwd]);

  // The popout hydrates via the refresh path, which skips chat-thread loading
  // (that only runs on a cold hydrate). Load this workspace's chat threads so
  // the browser lists chat sessions, not just coding ones.
  useEffect(() => {
    if (selection.workspaceId) void loadChatFromDb(selection.workspaceId);
  }, [selection.workspaceId, loadChatFromDb]);

  // Pull coding-session history for every project in the workspace so the tree
  // can list coding sessions, not just chat threads (hydration only loads chats).
  // M1: memoize ids key to avoid refetch loop when `projects` identity changes on hydrate.
  const projectIdsKey = useMemo(() => {
    const ids = projects
      .filter((project) => !selection.workspaceId || project.workspaceId === selection.workspaceId)
      .map((project) => project.id)
      .sort();
    return ids.join(",");
  }, [projects, selection.workspaceId]);
  const prevIdsKeyRef = useRef<string>("");
  useEffect(() => {
    if (projectIdsKey === prevIdsKeyRef.current) return;
    prevIdsKeyRef.current = projectIdsKey;
    const ids = projectIdsKey ? projectIdsKey.split(",") : [];
    if (ids.length) void fetchCodingSessionHistoryForProjects(ids);
  }, [projectIdsKey, fetchCodingSessionHistoryForProjects]);

  const workspaceProjects = useMemo(
    () => projects.filter((project) => !selection.workspaceId || project.workspaceId === selection.workspaceId),
    [projects, selection.workspaceId],
  );

  const sessionsByProject = useMemo(() => {
    const map = new Map<string, SessionSummary[]>();
    for (const project of workspaceProjects) {
      map.set(project.id, buildSessionRegistry({
        chatThreads,
        chatMessages,
        codingSessions: codingSessionHistory,
        terminalSessions,
        projectId: project.id,
      }));
    }
    return map;
  }, [workspaceProjects, chatThreads, chatMessages, codingSessionHistory, terminalSessions]);

  const workspaceName = workspaces.find((w) => w.id === selection.workspaceId)?.name;

  // H6: shared coalesced running-ids (same singleton as SessionBrowser)
  const runningIds = useSessionRunningIds(browserOpen);
  const isRunning = useCallback((session: SessionSummary): boolean =>
    runningIds.has(session.kind === "chat" ? `chat-${session.sourceId}` : session.sourceId),
  [runningIds]);

  const pickSession = useCallback((session: SessionSummary) => {
    // Coding sessions need their cwd for the runtime prompt; the registry summary
    // does not carry it, so resolve it from the coding history here.
    const cwd = session.kind === "coding"
      ? codingSessionHistory.find((candidate) => candidate.id === session.sourceId)?.cwd ?? null
      : null;
    setSelection({ ...toSelection(session, selection.workspaceId), cwd });
    setBrowserOpen(false);
  }, [selection.workspaceId, codingSessionHistory]);

  const toggleProject = useCallback((projectId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId); else next.add(projectId);
      return next;
    });
  }, []);

  return (
    <div className="flex flex-1 min-h-0">
      {browserOpen && (
        <aside className="flex flex-col w-60 flex-shrink-0 border-r border-[var(--border)] bg-[var(--surface)] min-h-0">
          <div className="flex items-center justify-between h-9 px-3 border-b border-[var(--border)] flex-shrink-0">
            <span className="text-[0.714rem] font-semibold text-[var(--text-secondary)] truncate">{workspaceName ?? "Sessions"}</span>
            <Tooltip content="Hide session browser" side="bottom">
              <button onClick={() => setBrowserOpen(false)} className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" aria-label="Hide session browser">
                <PanelLeftClose size={13} />
              </button>
            </Tooltip>
          </div>
          <div className="flex-1 overflow-y-auto py-1.5 min-h-0">
            {workspaceProjects.length === 0 ? (
              <p className="px-3 py-4 text-center text-[0.714rem] text-[var(--text-tertiary)]">No projects</p>
            ) : workspaceProjects.map((project) => {
              const sessions = sessionsByProject.get(project.id) ?? [];
              const isOpen = expanded.has(project.id);
              return (
                <div key={project.id} className="px-1">
                  <button
                    type="button"
                    onClick={() => toggleProject(project.id)}
                    className="flex items-center gap-1.5 w-full rounded-md px-2 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
                  >
                    {isOpen ? <ChevronDown size={12} className="text-[var(--text-tertiary)]" /> : <ChevronRight size={12} className="text-[var(--text-tertiary)]" />}
                    <span className="truncate font-medium">{project.name}</span>
                    <span className="ml-auto text-[0.714rem] text-[var(--text-tertiary)]">{sessions.length}</span>
                  </button>
                  {isOpen && (
                    <div role="listbox" aria-label={`${project.name} sessions`} className="ml-2 border-l border-[var(--border)] pl-1.5 space-y-0.5">
                      {sessions.length === 0 ? (
                        <p className="px-2 py-1.5 text-[0.714rem] text-[var(--text-tertiary)]">No sessions</p>
                      ) : sessions.map((session) => {
                        const selfId = session.kind === "chat" ? `chat-${session.sourceId}` : session.sourceId;
                        const selected = selfId === selection.sessionId;
                        const running = isRunning(session);
                        return (
                          <button
                            key={session.id}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            onClick={() => pickSession(session)}
                            className={cn(
                              "flex items-center gap-2 w-full rounded-md border-l-2 px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
                              selected ? "border-l-[var(--accent)] bg-[var(--accent-dim)]" : "border-l-transparent hover:bg-[var(--surface-2)]",
                            )}
                          >
                            <span className={cn("flex-shrink-0", selected ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]")}>
                              <SessionTypeIcon kind={session.kind} size={13} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs text-[var(--text-primary)]">{session.title}</span>
                              <span className="flex items-center gap-1.5 text-[0.714rem] text-[var(--text-tertiary)]">
                                <span>{kindLabel(session.kind)} · {formatDateCompact(session.updatedAt)}</span>
                                {running && (
                                  <span className="flex items-center gap-1 text-[var(--accent)]">
                                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" aria-hidden />
                                    running
                                  </span>
                                )}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </aside>
      )}
      <SessionPopoutConversation
        key={selection.sessionId}
        selection={selection}
        browserOpen={browserOpen}
        onToggleBrowser={() => setBrowserOpen((v) => !v)}
        onPopIn={onPopIn}
      />
    </div>
  );
}

interface ConversationProps {
  selection: PopoutSelection;
  browserOpen: boolean;
  onToggleBrowser: () => void;
  onPopIn: () => void;
}

/** The session-bound conversation. Keyed by session id so switching sessions in
 *  the browser cleanly remounts the pane, transcript, and live-event hook. */
function SessionPopoutConversation({ selection, browserOpen, onToggleBrowser, onPopIn }: ConversationProps) {
  const { sessionId, profile, activeProjectId, workspaceId, cwd } = selection;
  const threadId = sessionId.startsWith("chat-") ? sessionId.slice(5) : sessionId;
  const { aiConfig, agentConfig, projects } = useCairnStore(useShallow((s) => ({ aiConfig: s.aiConfig, agentConfig: s.agentConfig, projects: s.projects })));
  const project = projects.find((item) => item.id === activeProjectId);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [input, setInput] = useState("");
  const loadHistory = useCallback(async () => {
    const result = profile === "chat" ? await window.electron?.chat.sessionMessages(threadId) : await window.electron?.session.getSessionMessages(sessionId);
    return normalizeSessionMessages(result);
  }, [profile, sessionId, threadId]);
  const handleHistoryLoaded = useCallback((next: ConversationMessage[]) => {
    setMessages(next);
  }, []);
  const sessionConversation = useSessionConversation({
    sessionId,
    acceptUnscopedEvents: profile === "chat",
    adapter: {
      onTurnEnd: () => { void loadHistory().then(handleHistoryLoaded); },
      onProjection: (projection) => {
        if (projection.kind === "approval") setMessages((current) => applyApprovalProjection(current, projection.data as Record<string, unknown>));
      },
    },
  });
  const { isLoading, streamingContent, streamingThought, toolCalls, subagents, pendingQuestions, pendingQuestionCallId } = sessionConversation;
  const liveMessage: ConversationMessage | null = isLoading || streamingContent || streamingThought || toolCalls.length || subagents.length
    ? { id: `stream-${sessionId}`, role: "assistant", content: streamingContent, reasoning: streamingThought || undefined, toolCalls: toolCalls.map((tool) => ({ callId: tool.callId, name: tool.tool, label: tool.label, args: tool.args ? JSON.parse(tool.args) as Record<string, unknown> : undefined, running: tool.status === "running", ok: tool.ok !== false, output: tool.output, error: tool.error, meta: tool.meta, confirmRequired: tool.confirmRequired, approvalNonce: tool.approvalNonce })), subagents, isStreaming: true, createdAt: new Date().toISOString() }
    : null;
  const displayMessages = liveMessage ? [...messages, liveMessage] : messages;

  useEffect(() => {
    let cancelled = false;
    void window.electron?.session.isRunning(sessionId).then((state) => {
      if (cancelled) return;
      sessionConversation.syncRunning(state.running);
      const pending = state.pendingQuestions?.[0];
      if (pending) sessionConversation.setQuestions(pending.questions, pending.callId);
      for (const ask of state.pendingAsks) {
        sessionConversation.setToolApproval(ask.callId, true, ask.nonce);
        setMessages((current) => applyApprovalProjection(current, { callId: ask.callId, status: "required", nonce: ask.nonce }));
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
    // The bound session is fixed for this mount (switching remounts via key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || isLoading) return;
    setInput("");
    const optimistic: ConversationMessage = { id: `popout-${Date.now()}`, role: "user", content, createdAt: new Date().toISOString() };
    setMessages((current) => [...current, optimistic]);
    sessionConversation.startPrompt(() => window.electron?.session.prompt(profile === "chat"
      ? { sessionId, profile, prompt: content, projectId: activeProjectId ?? undefined, workspaceId: workspaceId ?? undefined, config: { provider: aiConfig.provider || "openai", baseUrl: aiConfig.baseUrl || undefined, model: aiConfig.model || undefined, apiKey: aiConfig.apiKey || undefined, maxSteps: aiConfig.maxSteps ?? 30, contextLimit: aiConfig.contextLimit, contextWindow: aiConfig.contextLimit } }
      : { sessionId, profile, prompt: content, projectId: activeProjectId ?? undefined, workspaceId: workspaceId ?? undefined, cwd: cwd ?? undefined, mode: "execute", config: agentConfig }));
  }

  return <ConversationPane
    className="chat-themed"
    sessionId={sessionId}
    profile={profile}
    messages={displayMessages}
    input={input}
    onInputChange={setInput}
    onPrompt={(text) => send(text)}
    onAbort={sessionConversation.stop}
    isLoading={isLoading}
    historyLoader={loadHistory}
    onHistoryLoaded={handleHistoryLoaded}
    centered={profile === "chat"}
    title={(
      <div className="flex items-center gap-1.5 min-w-0">
        <Tooltip content={browserOpen ? "Hide session browser" : "Show session browser"} side="bottom">
          <button onClick={onToggleBrowser} className="p-1 -ml-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" aria-label={browserOpen ? "Hide session browser" : "Show session browser"}>
            {browserOpen ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
          </button>
        </Tooltip>
        <span className="text-[0.714rem] font-semibold text-[var(--text-primary)] truncate">{project?.name ?? (profile === "coding" ? "Cairn Agent" : "Chat")}</span>
      </div>
    )}
    contextLimit={aiConfig.contextLimit ?? 128000}
    actions={(
      <Tooltip content="Return session to main window" side="bottom">
        <button onClick={onPopIn} className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" aria-label="Return session to main window"><ArrowLeftFromLine size={11} /></button>
      </Tooltip>
    )}
    projection={{ pendingQuestions, questionCallId: pendingQuestionCallId }}
    onAnswerQuestions={sessionConversation.answerQuestions}
    placeholder={profile === "coding" ? "Ask about your code…" : "Ask about your project…"}
    composerProps={{ statusText: "Shift+Enter for new line · Enter to send" }}
  />;
}
