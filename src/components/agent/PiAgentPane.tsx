"use client";

/**
 * PiAgentPane — chat UI for Cairn native agent sessions.
 *
 * Rendered inside AgentTerminalPane when session.sessionType === "pi".
 * Subscribes to pi-agent:* IPC events and updates Zustand store.
 * Multi-turn: each new message continues the same session's history.
 */

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { flushSync } from "react-dom";
import { Trash2, CheckCircle, FileText, Zap, Map as MapIcon } from "lucide-react";
import { QuestionForm } from "@/components/chat/chat-panel/QuestionForm";
import { ChatInput } from "@/components/chat/ChatInput";
import type { PendingQuestion } from "@/hooks/useChatStream";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { id } from "@/lib/utils";
import { PiMessageBubble } from "./PiMessageBubble";
import { PlanTaskList } from "./PlanTaskList";
import { ContextRing } from "./ContextRing";
import { Tooltip } from "@/components/ui/tooltip";
import { CairnEvents } from "@/lib/events";
import type { TerminalSession } from "@/store/slices/terminal-sessions";

// ── Cairn tool ref extraction ─────────────────────────────────────────────────

const NOTE_WRITE_TOOLS = new Set([
  "create_note", "ensure_note", "update_note", "patch_note", "append_to_note",
]);
const TASK_WRITE_TOOLS = new Set([
  "create_task", "update_task", "update_task_status",
]);
// Read-only tools — output is never useful to show; suppress it entirely
const READ_ONLY_TOOLS = new Set([
  "read", "grep", "find", "ls",
  "get_active_context", "get_project_context_pack",
  "list_notes", "get_note", "search_notes",
  "list_tasks", "get_task", "search_tasks", "list_ready_tasks",
  "get_idea_flow",
]);

function extractCairnRef(
  toolName: string,
  output: string | undefined,
): { type: "note" | "task"; id: string; title: string } | undefined {
  if (!output) return undefined;
  const isNote = NOTE_WRITE_TOOLS.has(toolName);
  const isTask = TASK_WRITE_TOOLS.has(toolName);
  if (!isNote && !isTask) return undefined;
  try {
    const parsed = JSON.parse(output);
    const refId    = parsed?.id;
    const refTitle = parsed?.title ?? parsed?.name ?? "(untitled)";
    if (!refId) return undefined;
    return { type: isNote ? "note" : "task", id: refId, title: refTitle };
  } catch {
    return undefined;
  }
}


interface PiAgentPaneProps {
  session: TerminalSession;
  isActive: boolean;
}

export function PiAgentPane({ session, isActive }: PiAgentPaneProps) {
  const {
    addPiMessage,
    appendPiToken,
    finalisePiMessage,
    addPiToolCall,
    clearPiMessages,
    ensurePiStreamingMessage,
    updatePiUsage,
    updatePiSubagentUsage,
    updatePiToolCall,
    updatePiSubagentToolCall,
    addPiSubagent,
    appendPiSubagentToken,
    finalisePiSubagentMessage: _finalisePiSubagentMessage,
    addPiSubagentToolCall,
    completePiSubagent,
    stepPiSubagent,
    setPiMode,
    setView,
    aiConfig,
    projects,
    activeWorkspaceId,
  } = useCairnStore(useShallow((s) => ({
    addPiMessage:              s.addPiMessage,
    appendPiToken:             s.appendPiToken,
    finalisePiMessage:         s.finalisePiMessage,
    addPiToolCall:             s.addPiToolCall,
    clearPiMessages:           s.clearPiMessages,
    ensurePiStreamingMessage:  s.ensurePiStreamingMessage,
    updatePiUsage:             s.updatePiUsage,
    updatePiSubagentUsage:     s.updatePiSubagentUsage,
    updatePiToolCall:          s.updatePiToolCall,
    updatePiSubagentToolCall:  s.updatePiSubagentToolCall,
    addPiSubagent:             s.addPiSubagent,
    appendPiSubagentToken:     s.appendPiSubagentToken,
    finalisePiSubagentMessage: s.finalisePiSubagentMessage,
    addPiSubagentToolCall:     s.addPiSubagentToolCall,
    completePiSubagent:        s.completePiSubagent,
    stepPiSubagent:            s.stepPiSubagent,
    setPiMode:                 s.setPiMode,
    setView:                   s.setView,
    aiConfig:                  s.aiConfig,
    projects:                  s.projects,
    activeWorkspaceId:         s.activeWorkspaceId,
  })));

  const messages    = session.piMessages ?? [];
  const project     = projects.find((p) => p.id === session.projectId);

  const [input, setInput]                         = useState("");
  const [isLoading, setIsLoading]                 = useState(false);
  const [pendingQuestions, setPendingQuestions]   = useState<PendingQuestion[] | null>(null);
  // Live PRD note content — updated whenever the agent writes to the plan note
  const [planNoteContent, setPlanNoteContent]     = useState<string | null>(null);
  // Retry state — shown in status bar when the loop is backing off after a transient error
  const [retryInfo, setRetryInfo]                 = useState<{ attempt: number; maxRetries: number; delayMs: number } | null>(null);
  // Compaction state — shown in status bar while an LLM summary call is in flight
  const [isCompacting, setIsCompacting]           = useState(false);

  const messagesEndRef  = useRef<HTMLDivElement>(null);
  const textareaRef     = useRef<HTMLTextAreaElement>(null);

  // Always-current reference to sendPrompt — lets the initialPrompt effect
  // call it after mount without capturing a stale closure.
  const sendPromptRef   = useRef<(text: string) => void>(() => {});
  const firedSessions   = useRef(new Set<string>());

  // Scroll to bottom on new messages
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, messages[messages.length - 1]?.content?.length]);
  /* eslint-enable react-hooks/exhaustive-deps */

  // Focus input when pane becomes active
  useEffect(() => {
    if (isActive) textareaRef.current?.focus();
  }, [isActive]);

  // Fire initialPrompt once when the session is loaded (set by SpawnAgentModal).
  // Uses a ref so we always call the current sendPrompt (not a stale closure).
  // Tracks fired session IDs in a Set ref to ensure we only queue this once per session
  // even across StrictMode remounts and tab switches.
  const { sessionId: initialSessionId, initialPrompt } = session;
  useEffect(() => {
    if (!initialPrompt) return;
    if (firedSessions.current.has(initialSessionId)) return;

    firedSessions.current.add(initialSessionId);
    // Defer 100ms so IPC listeners registered in the effect below are fully live.
    setTimeout(() => sendPromptRef.current(initialPrompt), 100);
  }, [initialSessionId, initialPrompt]);

  // Subscribe to IPC events for this session
  useEffect(() => {
    const electron = window.electron;
    if (!electron) return;

    const { sessionId } = session;

    const unsubToken = electron.piAgent.onToken((e) => {
      if (e.sessionId !== sessionId) return;
      appendPiToken(sessionId, e.delta);
    });

    const unsubUsage = electron.piAgent.onUsage((e) => {
      if (e.sessionId === sessionId) {
        // Parent step — update the parent ring
        updatePiUsage(sessionId, e.promptTokens, e.completionTokens);
      } else if (e.sessionId.startsWith(`${sessionId}:sub:`)) {
        // Subagent step — update usage on the subagent inline block, not the parent ring
        updatePiSubagentUsage(sessionId, e.sessionId, e.promptTokens, e.completionTokens);
      }
    });

    const unsubToolsReady = electron.piAgent.onToolsReady((e) => {
      if (e.sessionId === sessionId) {
        ensurePiStreamingMessage(sessionId);
      } else if (e.sessionId.startsWith(`${sessionId}:sub:`)) {
        // subagent — handled via subagent store (no-op here, subagent messages auto-create)
      }
    });

    // callId set: tracks in-flight callIds so we can clean up on end.
    // Keyed by callId (not tool name) so parallel calls to the same tool work correctly.
    const activeCallIds = new Set<string>();

    const unsubTool = electron.piAgent.onTool((e) => {
      if (e.sessionId !== sessionId) return;
      if (e.status === "pending") {
        // Chip created during SSE streaming — appears immediately with tool name as label.
        // flushSync ensures React commits this before the stream continues.
        const callId = e.callId ?? `${e.name}:${Date.now()}`;
        activeCallIds.add(callId);
        flushSync(() => {
          addPiToolCall(sessionId, { callId, name: e.name, label: e.label, running: true, ok: true });
        });
      } else if (e.status === "start") {
        // Execution starting — update the existing pending chip with the resolved label.
        const callId = e.callId ?? `${e.name}:${Date.now()}`;
        activeCallIds.add(callId);
        flushSync(() => {
          addPiToolCall(sessionId, { callId, name: e.name, label: e.label, running: true, ok: true });
        });
      } else if (e.status === "end") {
        const callId = e.callId ?? `${e.name}:unknown`;
        activeCallIds.delete(callId);
        updatePiToolCall(sessionId, callId, {
          label:    e.label,
          running:  false,
          ok:       e.ok ?? true,
          output:   READ_ONLY_TOOLS.has(e.name) ? undefined : e.output,
          cairnRef: extractCairnRef(e.name, e.output),
        });
      } else {
        console.warn("[PiAgentPane] unhandled pi-agent:tool status:", e.status, e);
      }
    });

    const unsubStep = electron.piAgent.onStep((e) => {
      if (e.sessionId !== sessionId) return;
      // Finalise the previous turn's assistant message so the next turn's
      // tokens appear in a separate bubble.
      finalisePiMessage(sessionId);
    });

    const unsubDone = electron.piAgent.onDone((e) => {
      if (e.sessionId !== sessionId) return;
      finalisePiMessage(sessionId);
      setIsLoading(false);
      setRetryInfo(null);
      setIsCompacting(false);
      // Persist the full message transcript after the turn completes
      const msgs = useCairnStore.getState().terminalSessions.find((t) => t.sessionId === sessionId)?.piMessages ?? [];
      const saveable = msgs.filter((m) => !m.isStreaming).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls ?? null,
        subagents: m.subagents ?? null,
        timestamp: m.timestamp,
      }));
      window.electron?.piAgent.saveMessages(sessionId, saveable).catch(console.error);
    });

    const unsubError = electron.piAgent.onError((e) => {
      if (e.sessionId !== sessionId) return;
      finalisePiMessage(sessionId);
      setRetryInfo(null);
      setIsCompacting(false);
      addPiMessage(sessionId, {
        id:        id(),
        role:      "error",
        content:   e.error,
        timestamp: new Date().toISOString(),
      });
      setIsLoading(false);
      // Persist the message transcript including the error message
      setTimeout(() => {
        const msgs = useCairnStore.getState().terminalSessions.find((t) => t.sessionId === sessionId)?.piMessages ?? [];
        const saveable = msgs.filter((m) => !m.isStreaming).map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          toolCalls: m.toolCalls ?? null,
          subagents: m.subagents ?? null,
          timestamp: m.timestamp,
        }));
        window.electron?.piAgent.saveMessages(sessionId, saveable).catch(console.error);
      }, 0);
    });

    // ── Subagent events (child session IDs routed back to parent) ──────────
    const unsubSubagent = electron.piAgent.onSubagent((e) => {
      if (e.parentSessionId !== sessionId) return;
      if (e.status === "start") {
        addPiSubagent(sessionId, e.childSessionId);
      } else {
        completePiSubagent(sessionId, e.childSessionId, e.result ?? "");
      }
    });

    const unsubSubToken = electron.piAgent.onToken((e) => {
      if (!e.sessionId.startsWith(`${sessionId}:sub:`)) return;
      appendPiSubagentToken(sessionId, e.sessionId, e.delta);
    });

    // Keyed by callId (not tool name) so parallel calls to the same tool resolve correctly.
    const activeSubCallIds = new Set<string>();

    const unsubSubTool = electron.piAgent.onTool((e) => {
      if (!e.sessionId.startsWith(`${sessionId}:sub:`)) return;
      if (e.status === "pending" || e.status === "start") {
        const callId = e.callId ?? `${e.name}:${Date.now()}`;
        activeSubCallIds.add(callId);
        flushSync(() => {
          addPiSubagentToolCall(sessionId, e.sessionId, { callId, name: e.name, label: e.label, running: true, ok: true });
        });
      } else if (e.status === "end") {
        const callId = e.callId ?? `${e.name}:unknown`;
        activeSubCallIds.delete(callId);
        updatePiSubagentToolCall(sessionId, e.sessionId, callId, {
          label:    e.label,
          running:  false,
          ok:       e.ok ?? true,
          output:   READ_ONLY_TOOLS.has(e.name) ? undefined : e.output,
          cairnRef: extractCairnRef(e.name, e.output),
        });
      } else {
        console.warn("[PiAgentPane] unhandled pi-agent:tool status (subagent):", e.status, e);
      }
    });

    const unsubSubStep = electron.piAgent.onStep((e) => {
      if (!e.sessionId.startsWith(`${sessionId}:sub:`)) return;
      stepPiSubagent(sessionId, e.sessionId);
    });

    // Plan mode events
    const unsubPlanNote = electron.piAgent.onPlanNote((e) => {
      if (e.sessionId !== sessionId) return;
      setPiMode(sessionId, "plan", e.noteId);
    });

    const unsubModeChange = electron.piAgent.onModeChange((e) => {
      if (e.sessionId !== sessionId) return;
      setPiMode(sessionId, e.mode, e.planNoteId);
    });

    const unsubAskQuestions = electron.piAgent.onAskQuestions((e) => {
      if (e.sessionId !== sessionId) return;
      setPendingQuestions(e.questions);
    });

    // Live plan note content updates — keep task list in sync as agent patches the PRD
    const unsubNoteUpdated = electron.piAgent.onNoteUpdated((e) => {
      if (e.sessionId !== sessionId) return;
      // Only track updates to this session's plan note
      const currentPlanNoteId = useCairnStore.getState().terminalSessions.find(
        (t) => t.sessionId === sessionId
      )?.planNoteId;
      if (!currentPlanNoteId || e.noteId !== currentPlanNoteId) return;
      setPlanNoteContent(e.content);
    });

    // Retry events — show backoff countdown in the status bar
    const unsubRetry = electron.piAgent.onRetry((e) => {
      if (e.sessionId !== sessionId) return;
      setRetryInfo({ attempt: e.attempt, maxRetries: e.maxRetries, delayMs: e.delayMs });
      // Auto-clear the retry badge once enough time has passed (delayMs + 500ms grace)
      setTimeout(() => setRetryInfo(null), e.delayMs + 500);
    });

    // Compaction events — show "Compacting…" in status bar while LLM summary is in flight
    const unsubCompact = electron.piAgent.onCompact((e) => {
      if (e.sessionId !== sessionId) return;
      setIsCompacting(e.status === "start");
    });

    // /compact result — inject a system message confirming compaction
    const unsubCompactResult = electron.piAgent.onCompactResult((e) => {
      if (e.sessionId !== sessionId) return;
      const msg = e.messageCount > 0
        ? `Context compacted — session history summarised into ${e.messageCount} messages.`
        : "Nothing to compact — session history is too short.";
      addPiMessage(sessionId, { id: id(), role: "system" as const, content: msg, timestamp: new Date().toISOString() });
    });

    return () => {
      unsubToken();
      unsubUsage();
      unsubToolsReady();
      unsubTool();
      unsubStep();
      unsubDone();
      unsubError();
      unsubSubagent();
      unsubSubToken();
      unsubSubTool();
      unsubSubStep();
      unsubPlanNote();
      unsubModeChange();
      unsubAskQuestions();
      unsubNoteUpdated();
      unsubRetry();
      unsubCompact();
      unsubCompactResult();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId]);

  const sendPrompt = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading || !session.cwd) return;

    // ── Slash commands ─────────────────────────────────────────────────────
    if (trimmed === "/compact") {
      setInput("");
      window.electron?.piAgent.compactNow({
        sessionId: session.sessionId,
        config: {
          baseUrl:  aiConfig.baseUrl  || undefined,
          model:    aiConfig.model    || undefined,
          apiKey:   aiConfig.apiKey   || undefined,
        },
      });
      return;
    }

    setInput("");
    setIsLoading(true);
    setPendingQuestions(null);

    // Add user message to store
    addPiMessage(session.sessionId, {
      id:        id(),
      role:      "user",
      content:   trimmed,
      timestamp: new Date().toISOString(),
    });

    // Create placeholder streaming assistant message
    addPiMessage(session.sessionId, {
      id:          id(),
      role:        "assistant",
      content:     "",
      isStreaming: true,
      timestamp:   new Date().toISOString(),
    });

    const promptPayload = {
      sessionId:   session.sessionId,
      prompt:      trimmed,
      projectId:   session.projectId,
      workspaceId: activeWorkspaceId ?? undefined,
      cwd:         session.cwd,
      taskTitle:   session.taskTitle !== "Ad-hoc session" ? session.taskTitle : undefined,
      mode:        session.mode ?? "execute",
      config: {
        baseUrl:     aiConfig.baseUrl     || undefined,
        model:       aiConfig.model       || undefined,
        apiKey:      aiConfig.apiKey      || undefined,
        maxSteps:    aiConfig.maxSteps    ?? 20,
        temperature: aiConfig.temperature ?? 0.3,
      },
    };
    window.electron?.piAgent.prompt(promptPayload);
  }, [isLoading, session, aiConfig, activeWorkspaceId, addPiMessage]);

  // Keep ref current so the initialPrompt effect always calls the latest version.
  // useLayoutEffect runs synchronously after render, keeping the ref up-to-date
  // before any async callbacks fire without triggering the react-hooks/refs lint rule.
  useLayoutEffect(() => { sendPromptRef.current = sendPrompt; });

  function handleStop() {
    window.electron?.piAgent.abort(session.sessionId);
    finalisePiMessage(session.sessionId);
    setIsLoading(false);
  }

  function handleClear() {
    if (isLoading) handleStop();
    clearPiMessages(session.sessionId);
    window.electron?.piAgent.clear(session.sessionId);
  }

  function handleApprovePlan() {
    if (!session.planNoteId || isLoading || !session.cwd) return;
    setIsLoading(true);
    // Add a system-style user message to mark the transition in the chat
    addPiMessage(session.sessionId, {
      id:        id(),
      role:      "user",
      content:   "Plan approved. Begin implementation.",
      timestamp: new Date().toISOString(),
    });
    addPiMessage(session.sessionId, {
      id:          id(),
      role:        "assistant",
      content:     "",
      isStreaming: true,
      timestamp:   new Date().toISOString(),
    });
    window.electron?.piAgent.approvePlan({
      sessionId:   session.sessionId,
      planNoteId:  session.planNoteId,
      projectId:   session.projectId,
      workspaceId: activeWorkspaceId ?? undefined,
      cwd:         session.cwd,
      taskTitle:   session.taskTitle !== "Ad-hoc session" ? session.taskTitle : undefined,
      config: {
        baseUrl:     aiConfig.baseUrl     || undefined,
        model:       aiConfig.model       || undefined,
        apiKey:      aiConfig.apiKey      || undefined,
        maxSteps:    aiConfig.maxSteps    ?? 20,
        temperature: aiConfig.temperature ?? 0.3,
      },
    });
  }

  return (
    <div className="flex flex-col h-full bg-[var(--background)]">

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0">
        <span className="text-[0.714rem] text-[var(--text-tertiary)] truncate flex-1">
          {session.taskTitle !== "Ad-hoc session" ? session.taskTitle : project?.name ?? "Cairn Agent"}
        </span>

        {/* Mode badge */}
        {session.mode === "plan" ? (
          <span className="flex items-center gap-1 text-[0.643rem] font-semibold px-1.5 py-0.5 rounded-full bg-[color-mix(in_srgb,var(--warning,#f59e0b)_15%,transparent)] text-[var(--warning,#f59e0b)]">
            <MapIcon size={9} />
            PLAN
          </span>
        ) : session.mode === "execute" ? (
          <span className="flex items-center gap-1 text-[0.643rem] font-semibold px-1.5 py-0.5 rounded-full bg-[var(--accent-dim)] text-[var(--accent)]">
            <Zap size={9} />
            EXECUTE
          </span>
        ) : null}

        {/* PRD note chip — shown when plan note exists */}
        {session.planNoteId && (
          <Tooltip content="Open plan note" side="left">
            <button
              onClick={() => {
                setView("notes");
                setTimeout(() => window.dispatchEvent(CairnEvents.selectNote(session.planNoteId!)), 50);
              }}
              className="flex items-center gap-1 text-[0.643rem] text-[var(--text-secondary)] hover:text-[var(--text-primary)] px-1.5 py-0.5 rounded-full border border-[var(--border)] hover:bg-[var(--surface-2)] transition-colors"
            >
              <FileText size={9} />
              PRD
            </button>
          </Tooltip>
        )}

        {/* Approve Plan button — plan mode only, once PRD note exists */}
        {session.mode === "plan" && session.planNoteId && !isLoading && (
          <Tooltip content="Approve plan and begin implementation" side="left">
            <button
              onClick={handleApprovePlan}
              className="flex items-center gap-1 text-[0.714rem] font-medium px-2 py-0.5 rounded-full bg-[var(--success,#22c55e)] text-white hover:opacity-90 transition-opacity"
            >
              <CheckCircle size={11} />
              Approve Plan
            </button>
          </Tooltip>
        )}

        {session.lastUsage && (
          <ContextRing
            promptTokens={session.lastUsage.promptTokens}
            contextLimit={aiConfig.contextLimit ?? 128000}
          />
        )}
        <Tooltip content="Clear conversation" side="left">
          <button
            onClick={handleClear}
            className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
          >
            <Trash2 size={12} />
          </button>
        </Tooltip>
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
            <p className="text-[0.786rem] font-medium text-[var(--text-secondary)]">
              {session.mode === "plan" ? "Plan Mode" : "Cairn Agent"}
            </p>
            <p className="text-[0.714rem] text-[var(--text-tertiary)] max-w-48">
              {session.mode === "plan"
                ? "Describe what you want to build — I'll ask questions and draft a plan before writing any code."
                : "Ask me to read, edit, or run code — or manage your project board."}
            </p>
          </div>
        )}
        {messages.map((msg) => (
          <PiMessageBubble key={msg.id} message={msg} />
        ))}
        {pendingQuestions && (
          <QuestionForm
            questions={pendingQuestions}
            onSubmit={(text) => sendPrompt(text)}
            disabled={isLoading}
          />
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input — with upward-expanding plan task list docked above it */}
      <div className="border-t border-[var(--border)] flex-shrink-0">
        {session.mode === "execute" && planNoteContent && (
          <PlanTaskList content={planNoteContent} />
        )}
      <div className="p-3">
        <ChatInput
          ref={textareaRef}
          value={input}
          onChange={setInput}
          onSubmit={() => sendPrompt(input)}
          onStop={handleStop}
          isLoading={isLoading}
          disabled={isLoading}
          placeholder={session.mode === "plan" ? "Describe what you want to build…" : "Ask the agent…"}
        />
        <p className="text-[0.643rem] text-[var(--text-tertiary)] mt-1 text-center">
          {retryInfo
            ? `Transient error — retrying (${retryInfo.attempt}/${retryInfo.maxRetries}) in ${Math.round(retryInfo.delayMs / 1000)}s…`
            : isCompacting
              ? "Compacting context…"
              : isLoading
                ? "Working… click ◼ to stop"
                : "Shift+Enter for new line · Enter to send"
          }
        </p>
      </div>
      </div>
    </div>
  );
}
