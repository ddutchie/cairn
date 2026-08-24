"use client";

/**
 * AgentChatPane — chat UI for Cairn native agent sessions.
 *
 * Rendered inside SessionPane when session.sessionType === "coding".
 * Subscribes to pi-agent:* IPC events and updates Zustand store.
 * Multi-turn: each new message continues the same session's history.
 */

import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore } from "react";
import { Trash2, FileText, Map as MapIcon } from "lucide-react";
import { QuestionForm } from "@/components/chat/chat-panel/QuestionForm";
import { ConversationComposer } from "@/components/conversation/ConversationComposer";
import type { SuggestionItem } from "@/components/chat/ChatInput";
import type { PendingQuestion } from "@/hooks/useChatStream";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn, id } from "@/lib/utils";
import { getCommandsForScope } from "@/lib/slash-commands";
import { useRegistryCommands } from "@/hooks/useRegistryCommands";
import { resolveMaxOutputTokens, supportsImageInput, normalizeContextLimit } from "../../../shared/models/model-catalog";
import { supportsPdfInput } from "../../../shared/models/pdf-attach";
import type { ConnectorMeta as AgentConnectorMeta } from "@/components/shared/ConnectorToolCard";
import { type VirtuosoHandle } from "react-virtuoso";
import { PlanTaskList } from "./PlanTaskList";
import { AgentTodoDock } from "./AgentTodoDock";
import { Tooltip } from "@/components/ui/tooltip";
import { revealNote } from "@/lib/events";
import { resolvePromptContext } from "@/lib/context-resolver";
import { useChatMessageQueue, useQueueDrain } from "@/hooks/useChatMessageQueue";
import { getModelInfo, prewarmModelCatalog, subscribeModelCatalog, getModelCatalogVersion, effectiveTemperatureForModel } from "@/lib/models-dev";
import { hasPromptFired, markPromptFired } from "@/lib/agent-prompt-guard";
import type { TerminalSession, TokenBreakdown, RegistryFetchResult } from "@/types";
import { redactAgentToolCall } from "@/lib/redact-agent-transcript";
import { ConversationTranscript } from "@/components/conversation/ConversationTranscript";
import { ConversationMessageBubble } from "@/components/conversation/ConversationMessageBubble";
import { toConversationMessage } from "@/components/conversation/conversation-message";
import { ConversationHeader } from "@/components/conversation/ConversationHeader";
import { ConversationEmptyState } from "@/components/conversation/ConversationEmptyState";
import { ConversationQueueDock, ConversationWorkingStatus, type ConversationQueuedItem } from "@/components/conversation/ConversationComposerParts";
import { createSessionEventFold } from "../../../shared/agent/session-event-fold";

// ── Cairn tool ref extraction ─────────────────────────────────────────────────

const NOTE_TOOLS = new Set([
  "create_note", "ensure_note", "update_note", "patch_note", "append_to_note", "get_note",
]);
const TASK_TOOLS = new Set([
  "create_task", "update_task", "update_task_status", "get_task",
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
  const isNote = NOTE_TOOLS.has(toolName);
  const isTask = TASK_TOOLS.has(toolName);
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

interface AgentChatPaneProps {
  session: TerminalSession;
  isActive: boolean;
}

/**
 * Session IDs whose initial prompt has already been fired. Module-level (NOT a
 * component ref) so the guard survives AgentChatPane remounts — the pane is
 * conditionally rendered (e.g. dropped when the active project has no
 * codeDirectory) and a ref would reset, letting the same session's initial
 * prompt fire again and re-spawn a task that was already started.
 */

export function AgentChatPane({ session, isActive }: AgentChatPaneProps) {
  // Actions — stable Zustand references, never trigger re-renders
  const addAgentMessage             = useCairnStore((s) => s.addAgentMessage);
  const appendAgentToken            = useCairnStore((s) => s.appendAgentToken);
  const appendAgentThought          = useCairnStore((s) => s.appendAgentThought);
  const finaliseAgentMessage        = useCairnStore((s) => s.finaliseAgentMessage);
  const addAgentToolCall             = useCairnStore((s) => s.addAgentToolCall);
  const clearAgentMessages          = useCairnStore((s) => s.clearAgentMessages);
  const updateAgentUsage            = useCairnStore((s) => s.updateAgentUsage);
  const updateAgentSubagentUsage    = useCairnStore((s) => s.updateAgentSubagentUsage);
  const updateAgentToolCall         = useCairnStore((s) => s.updateAgentToolCall);
  const updateAgentSubagentToolCall = useCairnStore((s) => s.updateAgentSubagentToolCall);
  const addAgentSubagentToolCall    = useCairnStore((s) => s.addAgentSubagentToolCall);
  const stepAgentSubagent           = useCairnStore((s) => s.stepAgentSubagent);
  const appendAgentSubagentToken    = useCairnStore((s) => s.appendAgentSubagentToken);
  const appendAgentSubagentThought  = useCairnStore((s) => s.appendAgentSubagentThought);
  const finaliseAgentSubagentMessage = useCairnStore((s) => s.finaliseAgentSubagentMessage);
  const setAgentMode                = useCairnStore((s) => s.setAgentMode);
  const _setAgentAutoApprove         = useCairnStore((s) => s.setAgentAutoApprove);
  const setAgentToolConfirmRequired = useCairnStore((s) => s.setAgentToolConfirmRequired);
  const setSessionTodos          = useCairnStore((s) => s.setSessionTodos);
  const setView                  = useCairnStore((s) => s.setView);

  // Reactive state — only values that actually drive re-renders
  const { agentConfig, projects, activeWorkspaceId, mcpServers, customServices } = useCairnStore(useShallow((s) => ({
    agentConfig:       s.agentConfig,
    projects:          s.projects,
    activeWorkspaceId: s.activeWorkspaceId,
    mcpServers:        s.mcpServers,
    customServices:    s.customServices,
  })));
  const sessionPresentation = useCairnStore((s) => s.sessionPresentation);
  const sessionTodos = useCairnStore((s) => s.sessionTodos[session.sessionId]);
  const customCommands = useCairnStore((s) => s.customCommands);
  const registryCommands = useRegistryCommands();
  const agentCommands = useMemo(
    () => getCommandsForScope("agent", customCommands, registryCommands),
    [customCommands, registryCommands]
  );

  const messages    = session.messages ?? [];

  // ── Virtualized transcript (react-virtuoso) ───────────────────────────────
  // Only messages near the viewport are mounted, so a session with thousands of
  // persisted messages (each with reasoning, tool chips, subagent traces) stays
  // light no matter how far you scroll — the DOM never grows with scroll depth.
  // Prompts the user queued while the agent was running — sent (FIFO) when the
  // current run finishes. Kept on Stop and drained after errors too. Attachments
  // are queued alongside so staged images/PDFs are never silently dropped.
  const { queued, queueExpanded, setQueueExpanded, enqueue, removeQueued, clearQueue, drainNext } = useChatMessageQueue<{ id: string; content: string; attachments?: Array<{ kind: "image" | "pdf"; name: string; dataUrl: string }> }>();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const lastSessionIdRef = useRef(session.sessionId);
  useEffect(() => {
    if (lastSessionIdRef.current !== session.sessionId) {
      lastSessionIdRef.current = session.sessionId;
      // Queued prompts belong to the previous session — drop them so they are
      // never sent into the newly selected session.
      clearQueue();
      // Jump to the newest message when switching sessions.
      if (messages.length > 0) {
        virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, align: "end" });
      }
    }
    // messages.length in deps is deliberate — the guard above short-circuits
    // so it only scrolls when the session actually changes.
  }, [session.sessionId, messages.length, clearQueue]);
  const project     = projects.find((p) => p.id === session.projectId);

  const [input, setInput]                         = useState("");
  const [isLoading, setIsLoading]                 = useState(false);
  const [pendingQuestions, setPendingQuestions]   = useState<PendingQuestion[] | null>(null);
  /** callId of the blocked ask_questions call — echoed back on answer. */
  const [pendingQuestionCallId, setPendingQuestionCallId] = useState<string | null>(null);
  // Live PRD note content — updated whenever the agent writes to the plan note
  const [planNoteContent, setPlanNoteContent]     = useState<string | null>(null);
  // Retry state — shown in status bar when the loop is backing off after a transient error
  const [retryInfo, setRetryInfo]                 = useState<{ attempt: number; maxRetries: number; delayMs: number } | null>(null);
  // Compaction state — shown in status bar while an LLM summary call is in flight
  const [isCompacting, setIsCompacting]           = useState(false);
  const [connectorEntries, setConnectorEntries]   = useState<RegistryFetchResult["manifest"] | null>(null);

  // Attachment support follows the agent's selected model (same as chat). The
  // models.dev catalog loads in the background, so subscribe to it — without
  // this, allowImages/allowPdf stay false until an unrelated re-render happens.
  useSyncExternalStore(subscribeModelCatalog, getModelCatalogVersion);
  const agentModelInfo = getModelInfo(agentConfig.model);
  const allowImages = supportsImageInput(agentModelInfo);
  const allowPdf = supportsPdfInput(agentModelInfo);

  const textareaRef     = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Warm the models.dev catalog so getModelInfo() can resolve the reasoning
    // flag (for the `developer` system role) once data arrives.
    prewarmModelCatalog();
    let cancelled = false;
    const fetchRegistry = window.electron?.registry?.fetch;
    if (!fetchRegistry) return () => { cancelled = true; };
    fetchRegistry().then((result) => {
      if (!cancelled) setConnectorEntries(result.manifest);
    }).catch(() => { /* connector cards fall back to generic metadata */ });
    return () => { cancelled = true; };
  }, [activeWorkspaceId]);

  const connectorMap = useMemo(() => {
    const map: Record<string, AgentConnectorMeta> = {};
    if (!connectorEntries) return map;
    for (const server of mcpServers) {
      const entry = connectorEntries.mcpServers.find((candidate) => candidate.id === server.communityId || candidate.definition.name === server.name);
      if (entry) map[`mcp__${server.id}__`] = { name: server.name, label: entry.definition.name, kind: "mcp", iconSvg: entry.iconSvg, brandColor: entry.brandColor };
    }
    for (const service of customServices) {
      const entry = connectorEntries.services.find((candidate) => candidate.id === service.communityId || candidate.definition.name === service.name);
      if (entry) map[`svc__${service.id}__`] = { name: service.name, label: entry.definition.name, kind: "service", iconSvg: entry.iconSvg, brandColor: entry.brandColor };
    }
    return map;
  }, [connectorEntries, mcpServers, customServices]);

  // Always-current reference to sendPrompt — lets the initialPrompt effect
  // call it after mount without capturing a stale closure.
  const sendPromptRef   = useRef<(text: string, attachments?: Array<{ kind: "image" | "pdf"; name: string; dataUrl: string }>) => void>(() => {});

  // Scroll to bottom on new messages / streaming growth, and whenever the
  // Scroll to the very END of the virtualized content when the pane becomes
  // active or the ask_questions form appears. Streaming follow is handled by
  // Virtuoso's followOutput. Use a scalar (pendingQuestions?.length) rather
  // than the array so React doesn't flag the dependency change.
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (isActive && virtuosoRef.current && messages.length > 0) {
      // scrollTo top=MAX reaches past the last item into the Footer, unlike
      // scrollToIndex which aligns only the final message item.
      virtuosoRef.current.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "smooth" });
    }
  }, [isActive, pendingQuestions?.length ?? 0]);
  /* eslint-enable react-hooks/exhaustive-deps */

  // Focus input when pane becomes active
  useEffect(() => {
    if (isActive) textareaRef.current?.focus();
  }, [isActive]);

  // Restore the busy state when this pane (re)mounts. isLoading is local state,
  // so a session that kept working while its UI was unmounted (e.g. the
  // automation Develop modal closed mid-run) would otherwise come back showing
  // an idle input. The main process tracks the live loop (`pi-agent:is-running`)
  // — poll it once on mount. When it reports not-running, any assistant message
  // the previous mount left in a streaming state (it unmounted before
  // pi-agent:done) is stale — finalise it so no ghost bubble lingers.
  //
  // Declared BEFORE the initial-prompt effect on purpose: on a genuinely fresh
  // mount the session hasn't fired a prompt yet, which means THIS mount is about
  // to fire its initial prompt and `sendPrompt` owns the busy state — querying
  // here would race (and could clobber) it. Only once the session has fired a
  // prompt in the past (a resume) is the main-process state authoritative.
  useEffect(() => {
    if (!hasPromptFired(session.sessionId)) return;
    let cancelled = false;
    const sync = async () => {
      // Settle before polling: a prompt fired on this very mount (initial
      // prompt or queue drain) is in flight to the main process, and is-running
      // could read false in the split second before runningLoops is populated —
      // which would wrongly flip the input to idle and finalise a live bubble.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const res = await window.electron?.session.isRunning(session.sessionId);
      if (cancelled) return;
      const running = res?.running ?? false;
      // Re-surface approval asks whose original push was lost to a reload —
      // the main-process loop is still blocked waiting on them.
      for (const ask of res?.pendingAsks ?? []) {
        setAgentToolConfirmRequired(session.sessionId, ask.callId, true, ask.nonce);
      }
      // Re-surface pending question asks (ask_questions / plan-review). The
      // main process kept the full question payload so we can rehydrate a
      // plan-review card after reload — otherwise the review would hang
      // forever with no visible answer path.
      const pq = res?.pendingQuestions?.[0];
      if (pq && pq.questions.length > 0) {
        setPendingQuestions(pq.questions as never);
        setPendingQuestionCallId(pq.callId);
      }
      if (running) {
        setIsLoading(true);
        return;
      }
      // Not running: anything still streaming is stale — the loop ended while
      // this pane was unmounted (pi-agent:done was missed). Finalise it so no
      // ghost bubble lingers, and show the idle input.
      setIsLoading(false);
      finaliseAgentMessage(session.sessionId);
      setRetryInfo(null);
      setPendingQuestions(null);
      setPendingQuestionCallId(null);
    };
    void sync();
    return () => { cancelled = true; };
  }, [session.sessionId, finaliseAgentMessage, setAgentToolConfirmRequired, setIsLoading, setRetryInfo, setPendingQuestions, setPendingQuestionCallId]);

  // Fire initialPrompt once when the session is loaded (set by SpawnAgentModal).
  // Uses a ref so we always call the current sendPrompt (not a stale closure).
  // Tracks fired session IDs in a Set ref to ensure we only queue this once per session
  // even across StrictMode remounts and tab switches.
  const { sessionId: initialSessionId, initialPrompt } = session;
  useEffect(() => {
    if (!initialPrompt) return;
    if (hasPromptFired(initialSessionId)) return;

    markPromptFired(initialSessionId);
    // Defer 100ms so IPC listeners registered in the effect below are fully live.
    setTimeout(() => sendPromptRef.current(initialPrompt), 100);
  }, [initialSessionId, initialPrompt]);

  // Subscribe to IPC events for this session
  useEffect(() => {
    const electron = window.electron;
    if (!electron) return;

    const { sessionId } = session;

    const fold = createSessionEventFold({
      onTurnStart: () => {
        setIsLoading(true);
        finaliseAgentMessage(sessionId);
      },
      onText: (delta) => appendAgentToken(sessionId, delta),
      onReasoning: (delta) => appendAgentThought(sessionId, delta),
      onUsage: (u) => updateAgentUsage(sessionId, u.promptTokens, u.completionTokens, u.reasoningTokens, u.breakdown as TokenBreakdown | undefined, u.cacheReadTokens, u.cacheCreationTokens),
      onToolCall: (call) => addAgentToolCall(sessionId, { callId: call.callId ?? `${call.name}:${Date.now()}`, name: call.name, label: call.name, args: call.args, running: true, ok: true }),
      onToolResult: (result) => {
        if (!result.callId) return;
        updateAgentToolCall(sessionId, result.callId, {
          label: result.name,
          args: result.args,
          running: false,
          ok: result.ok,
          output: READ_ONLY_TOOLS.has(result.name) ? undefined : redactAgentToolCall({ output: result.output }).output,
          cairnRef: extractCairnRef(result.name, result.output),
        });
      },
      onTurnEnd: (reason) => {
        finaliseAgentMessage(sessionId);
        setIsLoading(false);
        setRetryInfo(null);
        setIsCompacting(false);
        setPendingQuestions(null);
        setPendingQuestionCallId(null);
        if (reason && reason !== "completed" && reason !== "aborted") {
          addAgentMessage(sessionId, { id: id(), role: "error", content: `Agent turn ended abnormally (${reason})`, timestamp: new Date().toISOString() });
        }
      },
    });
    const unsubEvent = electron.session.onEvent((e) => {
      if (e.sessionId === sessionId) fold(e.event);
    });

    // ── Subagent events ────────────────────────────────────────────────────
    // Coding-agent subagents (dsh child sessions with header.origin=='subagent'
    // and header.parentSession==sessionId) come through the shared
    // chat:subagent* bus that cairnSubagentPlugin emits (not the pi-agent:*
    // bus — the pre-fix code subscribed to `pi-agent:*` with a `${sessionId}:sub:`
    // prefix that nothing ever emitted, making every delegation trace
    // invisible during a live run). Each event includes parentSession so we
    // can filter to just this pane's children.
    //
    // We map onto the SAME per-session subagent store the chat pane uses.
    const matchesParent = (parentSession?: string) => parentSession === sessionId;

    const unsubSubToken = electron.session.onSubagentToken?.((e) => {
      if (!matchesParent(e.parentSession)) return;
      appendAgentSubagentToken(sessionId, e.childId, e.delta);
    });
    const unsubSubThought = electron.session.onSubagentThought?.((e) => {
      if (!matchesParent(e.parentSession)) return;
      appendAgentSubagentThought(sessionId, e.childId, e.delta);
    });

    // Keyed by callId (not tool name) so parallel calls to the same tool resolve correctly.
    const activeSubCallIds = new Set<string>();

    const unsubSubToolCall = electron.session.onSubagentToolCall?.((e) => {
      if (!matchesParent(e.parentSession)) return;
      const callId = e.callId ?? `${e.tool}:${Date.now()}`;
      activeSubCallIds.add(callId);
      addAgentSubagentToolCall(sessionId, e.childId, { callId, name: e.tool, label: e.label, args: e.args, running: true, ok: true });
    });
    const unsubSubToolCallDone = electron.session.onSubagentToolCallDone?.((e) => {
      if (!matchesParent(e.parentSession)) return;
      const callId = e.callId ?? `${e.tool}:unknown`;
      activeSubCallIds.delete(callId);
      updateAgentSubagentToolCall(sessionId, e.childId, callId, {
        label:    e.tool,
        running:  false,
        ok:       e.ok ?? true,
        output:   READ_ONLY_TOOLS.has(e.tool) ? undefined : redactAgentToolCall({ output: e.output }).output,
        cairnRef: e.cairnRef ?? extractCairnRef(e.tool, e.output),
      });
    });
    const unsubSubUsage = electron.session.onSubagentUsage?.((e) => {
      if (!matchesParent(e.parentSession)) return;
      updateAgentSubagentUsage(sessionId, e.childId, e.promptTokens, e.completionTokens, e.reasoningTokens ?? 0, e.breakdown as TokenBreakdown | undefined, e.cacheReadTokens, e.cacheCreationTokens);
    });
    const unsubSub = electron.session.onSubagent?.((e) => {
      if (!matchesParent(e.parentSession)) return;
      if (e.status === "done") {
        // Finalise the child block when its session ends.
        stepAgentSubagent(sessionId, e.childId);
        finaliseAgentSubagentMessage(sessionId, e.childId);
      }
    });

    // Plan mode events
    const unsubPlanNote = electron.session.onPlanNote((e) => {
      if (e.sessionId !== sessionId) return;
      // Two shapes carry this event today:
      //   - dsh-plan-mode's exit_plan_mode: e.planContent is the full plan
      //     text (from the tool call args), e.noteId is undefined. Show the
      //     plan immediately without waiting for a note round-trip.
      //   - Legacy PRD-note flow: e.noteId is a real note id, e.planContent
      //     is undefined; the plan will be re-fetched via onNoteUpdated.
      if (e.planContent) setPlanNoteContent(e.planContent);
      setAgentMode(sessionId, "plan", e.noteId);
    });

    const unsubModeChange = electron.session.onModeChange((e) => {
      if (e.sessionId !== sessionId) return;
      setAgentMode(sessionId, e.mode, e.planNoteId);
    });

    const unsubAskQuestions = electron.session.onAskQuestions((e) => {
      if (e.sessionId !== sessionId) return;
      setPendingQuestions(e.questions);
      setPendingQuestionCallId(e.callId);
    });

    const unsubToolConfirmRequired = electron.session.onToolConfirmRequired((e) => {
      if (e.sessionId !== sessionId) return;
      setAgentToolConfirmRequired(sessionId, e.callId, true, e.nonce);
    });

    // The ask timed out unanswered and the loop settled it fail-closed —
    // retire the card so no dead approve/deny buttons linger.
    const unsubToolConfirmExpired = electron.session.onToolConfirmExpired?.((e) => {
      if (e.sessionId !== sessionId) return;
      setAgentToolConfirmRequired(sessionId, e.callId, false);
    });

    // Live plan note content updates — keep task list in sync as agent patches the PRD
    const unsubNoteUpdated = electron.session.onNoteUpdated((e) => {
      if (e.sessionId !== sessionId) return;
      // Only track updates to this session's plan note
      const currentPlanNoteId = useCairnStore.getState().terminalSessions.find(
        (t) => t.sessionId === sessionId
      )?.planNoteId;
      if (!currentPlanNoteId || e.noteId !== currentPlanNoteId) return;
      setPlanNoteContent(e.content);
    });

    // Todo list updates — live dock as the agent runs the todowrite tool
    const unsubTodos = electron.session.onTodos((e) => {
      if (e.sessionId !== sessionId) return;
      setSessionTodos(sessionId, e.todos);
    });

    // Doom-loop pause — the agent repeated a tool call with identical args.

    // Initial hydrate — load persisted todos when the pane mounts so a restored
    // session shows its list before the agent touches it again.
    electron.session.getTodos?.(sessionId).then((result) => {
      if (result?.length) setSessionTodos(sessionId, result);
    }).catch(() => { /* no persisted todos — dock stays hidden */ });

    // Retry events — show backoff countdown in the status bar
    const unsubRetry = electron.session.onRetry((e) => {
      if (e.sessionId !== sessionId) return;
      setRetryInfo({ attempt: e.attempt, maxRetries: e.maxRetries, delayMs: e.delayMs });
      // Auto-clear the retry badge once enough time has passed (delayMs + 500ms grace)
      setTimeout(() => setRetryInfo(null), e.delayMs + 500);
    });

    // Compaction events — show "Compacting…" in status bar while LLM summary is in flight
    const unsubCompact = electron.session.onCompact((e) => {
      if (e.sessionId !== sessionId) return;
      setIsCompacting(e.status === "start");
      if (e.status === "end" && e.auto) {
        addAgentMessage(sessionId, {
          id: id(),
          role: "system" as const,
          content: "----- Session Compacted -----",
          timestamp: new Date().toISOString(),
        });
      }
    });

    // /compact result — dsh's compactNow has rewritten the session surface (a
    // summary replace node). Reload the transcript from the JSONL session log
    // (session-as-truth) so the in-memory view matches the compacted history and
    // survives reload, then append a confirmation system message.
    const unsubCompactResult = electron.session.onCompactResult((e) => {
      if (e.sessionId !== sessionId) return;
      void (async () => {
        try {
          type RowType = {
            id: string; role: "user" | "assistant" | "error"; content: string;
            reasoning?: string | null; toolCalls: unknown[] | null; subagents: unknown[] | null; timestamp: string;
          };
          const sessRes = await (electron.session as unknown as { getSessionMessages: (id: string) => Promise<unknown> }).getSessionMessages(sessionId);
          let rows: RowType[] | undefined = undefined;
          let usage: TerminalSession["lastUsage"] = undefined;

          if (Array.isArray(sessRes)) {
            rows = sessRes as RowType[];
          } else if (sessRes && typeof sessRes === "object") {
            const raw = "data" in sessRes && (sessRes as { data?: unknown }).data ? (sessRes as { data: unknown }).data : sessRes;
            if (Array.isArray(raw)) {
              rows = raw as RowType[];
            } else if (raw && typeof raw === "object" && "messages" in raw && Array.isArray((raw as { messages?: unknown }).messages)) {
              rows = (raw as { messages: RowType[] }).messages;
              usage = (raw as { usage?: TerminalSession["lastUsage"] }).usage;
            }
          }

          if (rows && rows.length > 0) {
            const fresh = rows.map((r) => ({
              id: r.id, role: r.role, content: r.content,
              reasoning: (r.reasoning ?? undefined) as never,
              toolCalls: (r.toolCalls ?? undefined) as never,
              subagents: (r.subagents ?? undefined) as never,
              timestamp: r.timestamp,
            }));
            useCairnStore.setState((s) => ({
              terminalSessions: s.terminalSessions.map((t) => (t.sessionId === sessionId ? { ...t, messages: fresh, ...(usage ? { lastUsage: usage } : {}) } : t)),
            }));
          }
        } catch (err) {
          console.warn("[AgentChatPane] compact reload failed", err);
        }


        const msg = e.messageCount > 0
          ? `Context compacted — session history summarised into ${e.messageCount} messages.`
          : "Nothing to compact — session history is too short.";
        addAgentMessage(sessionId, { id: id(), role: "system" as const, content: msg, timestamp: new Date().toISOString() });
      })();
    });

    return () => {
      unsubEvent();
      unsubSubToken?.();
      unsubSubThought?.();
      unsubSubToolCall?.();
      unsubSubToolCallDone?.();
      unsubSubUsage?.();
      unsubSub?.();
      unsubPlanNote();
      unsubModeChange();
      unsubAskQuestions();
      unsubToolConfirmRequired();
      unsubToolConfirmExpired?.();
      unsubNoteUpdated();
      unsubTodos();
      unsubRetry();
      unsubCompact();
      unsubCompactResult();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId]);

  const sendPrompt = useCallback(async (text: string, attachments: Array<{ kind: "image" | "pdf"; name: string; dataUrl: string }> = []) => {
    const trimmed = text.trim();
    // Attachment-only submissions are valid (an image/PDF with no caption), so
    // only block when there is NEITHER text NOR attachments.
    if ((!trimmed && attachments.length === 0) || !session.cwd) return;

    // Mark the session as "has fired a prompt" so a later remount of this pane
    // knows to poll the main process for the live busy state instead of showing
    // an idle input (sessions without an initialPrompt never get marked
    // otherwise).
    markPromptFired(session.sessionId);

    // A run is already in progress — queue this prompt instead of interrupting.
    // The queue drains (FIFO) when the current run finishes. Attachments are
    // queued alongside the text so staged images/PDFs are never dropped.
    if (isLoading) {
      if (!trimmed && attachments.length === 0) return;
      enqueue({ id: id(), content: trimmed, attachments });
      setInput("");
      return;
    }

    // ── Slash commands ─────────────────────────────────────────────────────
    if (trimmed === "/compact") {
      setInput("");
      window.electron?.session.compactNow({
        sessionId: session.sessionId,
        config: {
          // Never coerce localhost URLs to "localllm" — that slug means the
          // built-in on-device llama-server (chat-only). Saved providers like
          // Ollama / LM Studio on localhost are plain OpenAI-compatible
          // endpoints and must reach the loop with their real baseUrl intact.
          provider: "openai",
          baseUrl:  agentConfig.baseUrl  || undefined,
          model:    agentConfig.model    || undefined,
          apiKey:   agentConfig.apiKey   || undefined,
          // Keep compaction's context-window threshold in sync with the agent's
          // real model limit (it would otherwise default to 128K).
          contextWindow: agentConfig.contextLimit,
        },
      });
      return;
    }

    // Other registry commands (/plan, plugin commands) execute through the dsh
    // command runtime on this session's resumed agent.
    const commandName = trimmed.startsWith("/")
      ? trimmed.slice(1).trim().split(/\s+/, 1)[0]
      : "";
    const commandMatch = commandName
      ? registryCommands.find((c) => c.name === commandName)
        ?? (commandName === "plan" ? { name: "plan", description: "Enter or leave plan mode" } : undefined)
      : undefined;
    if (commandMatch) {
      setInput("");
      const commandArgs = trimmed.slice(1).trim().slice(commandName.length).trim();
      void window.electron?.runtime?.executeCommand({ sessionId: session.sessionId, line: trimmed }).then((result) => {
        // dsh's /plan handler uses agent.steer() for its suffix. That works
        // while a live turn is open, but this command runs on an idle resumed
        // agent in Cairn. Submit the suffix as a normal user turn after the
        // command commits so it is not stranded in the disposed agent inbox.
        if (commandName === "plan" && commandArgs && commandArgs !== "off" && result?.kind === "success") {
          void sendPromptRef.current(commandArgs);
        }
      }).catch(() => { /* command errors are reported by the runtime layer */ });
      return;
    }

    setInput("");
    setIsLoading(true);
    setPendingQuestions(null);
    setPendingQuestionCallId(null);

    // Add user message to store (attachments rendered as thumbnails in transcript)
    addAgentMessage(session.sessionId, {
      id:        id(),
      role:      "user",
      content:   trimmed,
      images:    attachments.length > 0 ? attachments.map((a) => ({ url: a.dataUrl, name: a.name, kind: a.kind })) : undefined,
      timestamp: new Date().toISOString(),
    });

    // Create placeholder streaming assistant message
    addAgentMessage(session.sessionId, {
      id:          id(),
      role:        "assistant",
      content:     "",
      isStreaming: true,
      timestamp:   new Date().toISOString(),
    });

    // Resolve context references and append to prompt payload
    const store = useCairnStore.getState();
    const resolvedPrompt = await resolvePromptContext(
      trimmed,
      store.notes,
      store.cards,
      store.columns,
      session.cwd || null
    );

    const promptPayload = {
      sessionId:   session.sessionId,
      prompt:      resolvedPrompt,
      projectId:   session.projectId,
      workspaceId: activeWorkspaceId ?? undefined,
      cwd:         session.cwd,
      taskTitle:   session.taskTitle !== "Ad-hoc session" ? session.taskTitle : undefined,
      mode:        session.mode ?? "execute",
      attachments: attachments.length > 0 ? attachments : undefined,
      config: {
        // See the /compact comment above: localhost ≠ built-in Local Engine.
        // Ollama / LM Studio providers stay "openai" with their own baseUrl.
        provider:   "openai",
        baseUrl:     agentConfig.baseUrl     || undefined,
        model:       agentConfig.model       || undefined,
        apiKey:      agentConfig.apiKey      || undefined,
         maxSteps:    agentConfig.maxSteps    ?? 30,
         // Plan mode always uses 0.1 for deterministic analysis; otherwise the
         // user's setting. Auto/unset or unsupported → omitted (vendor default).
         temperature: effectiveTemperatureForModel(
           agentConfig.model,
           session.mode === "plan" ? 0.1 : agentConfig.temperature,
         ),
          // The agent's real context limit — drives the sliding-window pruner
          // (and compaction) so long contexts are trimmed at the model's window,
          // not a hardcoded 128K default.
          contextWindow: agentConfig.contextLimit,
          // Auto → send a generous 32K cap (bounded by the model's declared
          // output limit) so the model can finish naturally.
          maxTokens:   resolveMaxOutputTokens(
            agentConfig.maxOutputAuto === false ? agentConfig.maxOutputTokens : undefined,
            getModelInfo(agentConfig.model)?.maxOutput,
          ),
          autoApprove: session.autoApprove ?? agentConfig.autoApprove ?? true,
          // Reasoning models get the `developer` system role (OpenAI convention).
          isReasoningModel: getModelInfo(agentConfig.model)?.reasoning === true,
       },
    };
    window.electron?.session.prompt(promptPayload);
  }, [isLoading, session, agentConfig, activeWorkspaceId, addAgentMessage, setInput, enqueue, registryCommands]);

  // Keep ref current so the initialPrompt effect always calls the latest version.
  // useLayoutEffect runs synchronously after render, keeping the ref up-to-date
  // before any async callbacks fire without triggering the react-hooks/refs lint rule.
  useLayoutEffect(() => { sendPromptRef.current = sendPrompt; });

  // Drain the queue: when a run finishes (loading went true → false), send the
  // next queued prompt. Keeps the queue on Stop and drains after errors.
  useQueueDrain(isLoading, drainNext, (next) => {
    sendPromptRef.current(next.content, next.attachments);
  });

  // Doom-loop decision: allow → the repeated call runs and the session stops
  // re-pausing; deny → the main loop halts with an error.

  // Answers to a blocked ask_questions call. The formatted text is returned to
  // the loop as the tool result (opencode-style) rather than starting a new turn.
  const submitQuestions = useCallback((answersText: string) => {
    if (!pendingQuestionCallId) {
      // No blocked call (stale form) — fall back to a plain user message.
      void sendPrompt(answersText);
      return;
    }
    window.electron?.session.respondQuestions(session.sessionId, pendingQuestionCallId, answersText);
    setPendingQuestions(null);
    setPendingQuestionCallId(null);
  }, [pendingQuestionCallId, session, sendPrompt]);

  const handleSearchFiles = useCallback(async (query: string): Promise<SuggestionItem[]> => {
    if (!window.electron || !session.cwd) return [];
    try {
      const files = await window.electron.agent.searchFiles(session.cwd, query);
      return files.map((f) => ({
        id: f.path,
        type: "file",
        title: f.relativePath,
        subtitle: "File",
      }));
    } catch (err) {
      console.error("[pi-agent:autocomplete] searchFiles failed:", err);
      return [];
    }
  }, [session.cwd]);

  function handleStop() {
    window.electron?.session.abort(session.sessionId);
    finaliseAgentMessage(session.sessionId);
    setIsLoading(false);
    setPendingQuestions(null);
    setPendingQuestionCallId(null);
  }

  function handleClear() {
    if (isLoading) handleStop();
    // Clearing the conversation must also drop anything queued for it — the
    // drain effect (which fires when handleStop flips isLoading to false) would
    // otherwise immediately send the queued prompts into a cleared session.
    clearQueue();
    clearAgentMessages(session.sessionId);
    setSessionTodos(session.sessionId, []);
    window.electron?.session.clear(session.sessionId);
  }

  // Plan approval flows through dsh's exit_plan_mode tool and the structured
  // review ask in QuestionForm. Approval unblocks the same coding turn; dsh
  // applies the mode exit at the next step boundary.


  return (
    <div className="flex flex-col h-full bg-[var(--surface)]">

      {/* Header */}
      <ConversationHeader
        title={session.taskTitle !== "Ad-hoc session" ? session.taskTitle : project?.name ?? "Cairn Agent"}
        contextLimit={normalizeContextLimit(agentConfig.contextLimit)}
        usage={session.lastUsage}
        actions={(
          <>

        {/* Passive mode status. DSH owns entry/exit through /plan and
            exit_plan_mode; this is intentionally not a second toggle. */}
        {session.mode === "plan" && (
          <span className="flex items-center gap-1 text-[0.643rem] font-semibold px-1.5 py-0.5 rounded-full bg-[color-mix(in_srgb,var(--warning,#f59e0b)_15%,transparent)] text-[var(--warning,#f59e0b)]">
            <MapIcon size={9} />
            PLAN
          </span>
        )}

        {/* PRD note chip — shown when plan note exists */}
        {session.planNoteId && (
          <Tooltip content="Open plan note" side="left">
            <button
              onClick={() => revealNote(setView, session.planNoteId!)}
              className="flex items-center gap-1 text-[0.643rem] text-[var(--text-secondary)] hover:text-[var(--text-primary)] px-1.5 py-0.5 rounded-full border border-[var(--border)] hover:bg-[var(--surface-2)] transition-colors"
            >
              <FileText size={9} />
              PRD
            </button>
          </Tooltip>
        )}


        <Tooltip content="Clear conversation" side="left">
          <button
            onClick={handleClear}
            className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
          >
            <Trash2 size={12} />
          </button>
        </Tooltip>
          </>
        )}
      />

      {/* Messages */}
      {/* Messages — virtualized so a session with thousands of persisted
          messages (each with reasoning, tool chips, subagent traces) only ever
          mounts the items near the viewport, no matter how far you scroll. */}
      <ConversationTranscript
        transcriptRef={virtuosoRef}
        className="flex-1 min-h-0"
        data={messages}
        initialTopMostItemIndex={Math.max(0, messages.length - 1)}
        emptyPlaceholder={() => (
          <ConversationEmptyState
            title={session.mode === "plan" ? "Plan Mode" : "Cairn Agent"}
            description={session.mode === "plan"
              ? "Describe what you want to build — I'll ask questions and draft a plan before writing any code."
              : "Ask me to read, edit, or run code — or manage your project board."}
          />
        )}
        footer={() => <div className="px-3 pt-3 pb-3 space-y-3" />}
        itemContent={(_index, msg) => (
          <div className={cn("px-4 py-1.5", sessionPresentation === "center" && "max-w-3xl mx-auto w-full")}>
            <ConversationMessageBubble
              message={toConversationMessage(msg)}
              sessionId={session.sessionId}
              connectors={connectorMap}
            />
          </div>
        )}
      />

      {/* Input — with upward-expanding plan task list docked above it */}
      <div className={cn("flex-shrink-0", sessionPresentation === "center" && "max-w-3xl mx-auto w-full")}>
        {/* Keep blocking questions outside Virtuoso's Footer. The footer
            component is recreated while the transcript streams, which can
            remount QuestionForm and discard answers typed into the form. */}
        {pendingQuestions && (
          <div className="px-3 pt-3">
            <QuestionForm
              questions={pendingQuestions}
              onSubmit={submitQuestions}
              onSubmitStructured={(json) => { submitQuestions(json); return true; }}
              disabled={false}
            />
          </div>
        )}
        {/* Pinned status strip: always visible above the input even when the
            transcript is scrolled up. Shows the working state and the queued
            message count — the queue stays collapsed so full message content
            is only rendered when the user expands it. */}
        {isLoading && !pendingQuestions && <ConversationWorkingStatus label="Agent is working — you can queue messages below" />}
        <ConversationQueueDock items={queued as ConversationQueuedItem[]} expanded={queueExpanded} onToggle={() => setQueueExpanded((v) => !v)} onRemove={removeQueued} noun="message" />
        {/* Plan review is rendered by QuestionForm from dsh's
            exit_plan_mode interaction. */}
        {session.mode === "execute" && planNoteContent && (
          <PlanTaskList content={planNoteContent} />
        )}
        {session.mode === "execute" && (sessionTodos?.length ?? 0) > 0 && (
          <AgentTodoDock todos={sessionTodos ?? []} live={false} />
        )}
      <div>
        <ConversationComposer
          centered={sessionPresentation === "center"}
          ref={textareaRef}
          value={input}
          onChange={setInput}
          onSubmit={sendPrompt}
          onStop={handleStop}
          isLoading={isLoading}
          queueWhileBusy={isLoading}
          queuedCount={queued.length}
          placeholder={session.mode === "plan" ? "Describe what you want to build…" : "Ask the agent…"}
          commands={agentCommands}
          onSearchSuggestions={handleSearchFiles}
          allowImages={allowImages}
          allowPdf={allowPdf}
          providerModelTarget="agent"
          statusText={retryInfo
            ? `Transient error — retrying (${retryInfo.attempt}/${retryInfo.maxRetries}) in ${Math.round(retryInfo.delayMs / 1000)}s…`
            : pendingQuestions
              ? "Waiting for your answers…"
              : isCompacting
                ? "Compacting context…"
                : isLoading
                  ? "Working… click ◼ to stop"
                  : "Shift+Enter for new line · Enter to send"}
        />
      </div>
      </div>
    </div>
  );
}
