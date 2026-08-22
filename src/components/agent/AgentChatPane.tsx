"use client";

/**
 * AgentChatPane — chat UI for Cairn native agent sessions.
 *
 * Rendered inside SessionPane when session.sessionType === "pi".
 * Subscribes to pi-agent:* IPC events and updates Zustand store.
 * Multi-turn: each new message continues the same session's history.
 */

import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore } from "react";
import { Trash2, FileText, Zap, Map as MapIcon, Loader2, Clock, ChevronDown } from "lucide-react";
import { QuestionForm } from "@/components/chat/chat-panel/QuestionForm";
import { ChatInputArea } from "@/components/chat/ChatInputArea";
import type { SuggestionItem } from "@/components/chat/ChatInput";
import type { PendingQuestion } from "@/hooks/useChatStream";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { id } from "@/lib/utils";
import { getCommandsForScope } from "@/lib/slash-commands";
import { useRegistryCommands } from "@/hooks/useRegistryCommands";
import { resolveMaxOutputTokens, supportsImageInput, normalizeContextLimit } from "../../../shared/models/model-catalog";
import { supportsPdfInput } from "../../../shared/models/pdf-attach";
import { AgentMessageBubble } from "./AgentMessageBubble";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { PlanApprovalCard } from "./PlanApprovalCard";
import { PlanTaskList } from "./PlanTaskList";
import { AgentTodoDock } from "./AgentTodoDock";
import { ContextRing } from "./ContextRing";
import { Tooltip } from "@/components/ui/tooltip";
import { revealNote } from "@/lib/events";
import { resolvePromptContext } from "@/lib/context-resolver";
import { useChatMessageQueue, useQueueDrain } from "@/hooks/useChatMessageQueue";
import { getModelInfo, prewarmModelCatalog, subscribeModelCatalog, getModelCatalogVersion, effectiveTemperatureForModel } from "@/lib/models-dev";
import { hasPromptFired, markPromptFired } from "@/lib/agent-prompt-guard";
import type { PiAgentMessage, TerminalSession, TokenBreakdown, RegistryFetchResult } from "@/types";
import type { AgentConnectorMeta } from "./AgentMessageBubble";
import { redactAgentToolCall } from "@/lib/redact-agent-transcript";

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

/**
 * Persist the session's finalised message transcript. Pi-agent transcripts are
 * now persisted by dsh's JSONL session log (session-as-truth), so this is a
 * no-op — see persistPiTranscript below.
 */
function persistPiTranscript(sessionId: string): void {
  // Pi-agent transcripts are persisted by dsh's JSONL session log (session-as-truth,
  // read back via db:piSession:sessionMessages with a SQLite fallback for pre-dsh
  // sessions). The pi_agent_messages SQLite table is legacy, so we no longer write
  // to it — the in-memory store keeps the live transcript, and a reload rebuilds it
  // from the jsonl. Kept as a no-op so the onDone/onError call sites are unchanged.
  void sessionId;
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
  const addPiMessage             = useCairnStore((s) => s.addPiMessage);
  const appendPiToken            = useCairnStore((s) => s.appendPiToken);
  const appendPiThought          = useCairnStore((s) => s.appendPiThought);
  const finalisePiMessage        = useCairnStore((s) => s.finalisePiMessage);
  const addPiToolCall             = useCairnStore((s) => s.addPiToolCall);
  const clearPiMessages          = useCairnStore((s) => s.clearPiMessages);
  const ensurePiStreamingMessage = useCairnStore((s) => s.ensurePiStreamingMessage);
  const updatePiUsage            = useCairnStore((s) => s.updatePiUsage);
  const updatePiSubagentUsage    = useCairnStore((s) => s.updatePiSubagentUsage);
  const updatePiToolCall         = useCairnStore((s) => s.updatePiToolCall);
  const updatePiSubagentToolCall = useCairnStore((s) => s.updatePiSubagentToolCall);
  const addPiSubagentToolCall    = useCairnStore((s) => s.addPiSubagentToolCall);
  const stepPiSubagent           = useCairnStore((s) => s.stepPiSubagent);
  const appendPiSubagentToken    = useCairnStore((s) => s.appendPiSubagentToken);
  const appendPiSubagentThought  = useCairnStore((s) => s.appendPiSubagentThought);
  const _finalisePiSubagentMessage = useCairnStore((s) => s.finalisePiSubagentMessage);
  const setPiMode                = useCairnStore((s) => s.setPiMode);
  const setPiAutoApprove         = useCairnStore((s) => s.setPiAutoApprove);
  const setPiToolConfirmRequired = useCairnStore((s) => s.setPiToolConfirmRequired);
  const setPiSessionTodos        = useCairnStore((s) => s.setPiSessionTodos);
  const setView                  = useCairnStore((s) => s.setView);

  // Reactive state — only values that actually drive re-renders
  const { agentConfig, projects, activeWorkspaceId, mcpServers, customServices } = useCairnStore(useShallow((s) => ({
    agentConfig:       s.agentConfig,
    projects:          s.projects,
    activeWorkspaceId: s.activeWorkspaceId,
    mcpServers:        s.mcpServers,
    customServices:    s.customServices,
  })));
    const sessionTodos = useCairnStore((s) => s.piSessionTodos[session.sessionId]);
  const customCommands = useCairnStore((s) => s.customCommands);
  const registryCommands = useRegistryCommands();
  const agentCommands = useMemo(
    () => getCommandsForScope("agent", customCommands, registryCommands),
    [customCommands, registryCommands]
  );

  const messages    = session.piMessages ?? [];

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
  /** Active doom-loop pause — the agent repeated a tool call with identical args. */
  const [doomLoop, setDoomLoop]                   = useState<{ toolName: string; count: number; callId: string; args?: Record<string, unknown> } | null>(null);
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
  // active or the ask_questions form appears (the form renders in Virtuoso's
  // Footer, so it can otherwise stay below the viewport if the user had
  // scrolled up when the model asked its questions). Streaming follow is
  // handled by Virtuoso's followOutput. Use a scalar (pendingQuestions?.length)
  // rather than the array so React doesn't flag the dependency change.
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
      const running = (await window.electron?.piAgent.isRunning(session.sessionId)) ?? false;
      if (cancelled) return;
      if (running) {
        setIsLoading(true);
        return;
      }
      // Not running: anything still streaming is stale — the loop ended while
      // this pane was unmounted (pi-agent:done was missed). Finalise it so no
      // ghost bubble lingers, and show the idle input.
      setIsLoading(false);
      finalisePiMessage(session.sessionId);
      setRetryInfo(null);
      setPendingQuestions(null);
      setPendingQuestionCallId(null);
      setDoomLoop(null);
    };
    void sync();
    return () => { cancelled = true; };
  }, [session.sessionId, finalisePiMessage]);

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

    const unsubToken = electron.piAgent.onToken((e) => {
      if (e.sessionId !== sessionId) return;
      appendPiToken(sessionId, e.delta);
    });

    const unsubThought = electron.piAgent.onThought?.((e) => {
      if (e.sessionId !== sessionId) return;
      appendPiThought(sessionId, e.delta);
    });

    const unsubUsage = electron.piAgent.onUsage((e) => {
      if (e.sessionId === sessionId) {
        // Parent step — update the parent ring
        updatePiUsage(sessionId, e.promptTokens, e.completionTokens, e.reasoningTokens ?? 0, e.breakdown as TokenBreakdown | undefined, e.cacheReadTokens, e.cacheCreationTokens);
      } else if (e.sessionId.startsWith(`${sessionId}:sub:`)) {
        // Subagent step — update usage on the subagent inline block, not the parent ring
        updatePiSubagentUsage(sessionId, e.sessionId, e.promptTokens, e.completionTokens, e.reasoningTokens ?? 0, e.breakdown as TokenBreakdown | undefined, e.cacheReadTokens, e.cacheCreationTokens);
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
         addPiToolCall(sessionId, { callId, name: e.name, label: e.label, args: e.args, running: true, ok: true });
      } else if (e.status === "start") {
        // Execution starting — update the existing pending chip with the resolved label.
        const callId = e.callId ?? `${e.name}:${Date.now()}`;
        activeCallIds.add(callId);
         addPiToolCall(sessionId, { callId, name: e.name, label: e.label, args: e.args, running: true, ok: true });
      } else if (e.status === "end") {
        const callId = e.callId ?? `${e.name}:unknown`;
        activeCallIds.delete(callId);
        updatePiToolCall(sessionId, callId, {
           label:    e.label,
           args:     e.args,
          running:  false,
          ok:       e.ok ?? true,
          output:   READ_ONLY_TOOLS.has(e.name) ? undefined : redactAgentToolCall({ output: e.output }).output,
          cairnRef: extractCairnRef(e.name, e.output),
        });
      } else {
        console.warn("[AgentChatPane] unhandled pi-agent:tool status:", e.status, e);
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
      setPendingQuestions(null);
      setPendingQuestionCallId(null);
      setDoomLoop(null);
      // Persist the full message transcript after the turn completes
      persistPiTranscript(sessionId);
    });

    const unsubError = electron.piAgent.onError((e) => {
      if (e.sessionId !== sessionId) return;
      finalisePiMessage(sessionId);
      setRetryInfo(null);
      setIsCompacting(false);
      setPendingQuestions(null);
      setPendingQuestionCallId(null);
      setDoomLoop(null);
      addPiMessage(sessionId, {
        id:        id(),
        role:      "error",
        content:   e.error,
        timestamp: new Date().toISOString(),
      });
      setIsLoading(false);
      // Persist the message transcript including the error message
      setTimeout(() => persistPiTranscript(sessionId), 0);
    });

    // ── Subagent events (child session IDs routed back to parent) ──────────
    const unsubSubToken = electron.piAgent.onToken((e) => {
      if (!e.sessionId.startsWith(`${sessionId}:sub:`)) return;
      appendPiSubagentToken(sessionId, e.sessionId, e.delta);
    });

    const unsubSubThought = electron.piAgent.onThought?.((e) => {
      if (!e.sessionId.startsWith(`${sessionId}:sub:`)) return;
      appendPiSubagentThought(sessionId, e.sessionId, e.delta);
    });

    // Keyed by callId (not tool name) so parallel calls to the same tool resolve correctly.
    const activeSubCallIds = new Set<string>();

    const unsubSubTool = electron.piAgent.onTool((e) => {
      if (!e.sessionId.startsWith(`${sessionId}:sub:`)) return;
      if (e.status === "pending" || e.status === "start") {
        const callId = e.callId ?? `${e.name}:${Date.now()}`;
        activeSubCallIds.add(callId);
         addPiSubagentToolCall(sessionId, e.sessionId, { callId, name: e.name, label: e.label, args: e.args, running: true, ok: true });
      } else if (e.status === "end") {
        const callId = e.callId ?? `${e.name}:unknown`;
        activeSubCallIds.delete(callId);
        updatePiSubagentToolCall(sessionId, e.sessionId, callId, {
           label:    e.label,
           args:     e.args,
          running:  false,
          ok:       e.ok ?? true,
          output:   READ_ONLY_TOOLS.has(e.name) ? undefined : redactAgentToolCall({ output: e.output }).output,
          cairnRef: extractCairnRef(e.name, e.output),
        });
      } else {
        console.warn("[AgentChatPane] unhandled pi-agent:tool status (subagent):", e.status, e);
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
      setPendingQuestionCallId(e.callId);
    });

    const unsubToolConfirmRequired = electron.piAgent.onToolConfirmRequired((e) => {
      if (e.sessionId !== sessionId) return;
      setPiToolConfirmRequired(sessionId, e.callId, true);
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

    // Todo list updates — live dock as the agent runs the todowrite tool
    const unsubTodos = electron.piAgent.onTodos((e) => {
      if (e.sessionId !== sessionId) return;
      setPiSessionTodos(sessionId, e.todos);
    });

    // Doom-loop pause — the agent repeated a tool call with identical args.
    const unsubDoomLoop = electron.piAgent.onDoomLoop((e) => {
      if (e.sessionId !== sessionId) return;
      setDoomLoop({ toolName: e.toolName, count: e.count, callId: e.callId, args: e.args });
    });

    // Initial hydrate — load persisted todos when the pane mounts so a restored
    // session shows its list before the agent touches it again.
    electron.piAgent.getTodos?.(sessionId).then((result) => {
      if (result?.length) setPiSessionTodos(sessionId, result);
    }).catch(() => { /* no persisted todos — dock stays hidden */ });

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
      if (e.status === "end" && e.auto) {
        addPiMessage(sessionId, {
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
    const unsubCompactResult = electron.piAgent.onCompactResult((e) => {
      if (e.sessionId !== sessionId) return;
      void (async () => {
        try {
          const rows = await (electron.piAgent as unknown as { getSessionMessages: (id: string) => Promise<unknown> }).getSessionMessages(sessionId) as Array<{
            id: string; role: "user" | "assistant" | "error"; content: string;
            reasoning?: string | null; toolCalls: unknown[] | null; subagents: unknown[] | null; timestamp: string;
          }> | undefined;
          if (rows && rows.length > 0) {
            const fresh = rows.map((r) => ({
              id: r.id, role: r.role, content: r.content,
              reasoning: (r.reasoning ?? undefined) as never,
              toolCalls: (r.toolCalls ?? undefined) as never,
              subagents: (r.subagents ?? undefined) as never,
              timestamp: r.timestamp,
            }));
            useCairnStore.setState((s) => ({
              terminalSessions: s.terminalSessions.map((t) => (t.sessionId === sessionId ? { ...t, piMessages: fresh } : t)),
            }));
          }
        } catch (err) {
          console.warn("[AgentChatPane] compact reload failed", err);
        }
        const msg = e.messageCount > 0
          ? `Context compacted — session history summarised into ${e.messageCount} messages.`
          : "Nothing to compact — session history is too short.";
        addPiMessage(sessionId, { id: id(), role: "system" as const, content: msg, timestamp: new Date().toISOString() });
      })();
    });

    return () => {
      unsubToken();
      unsubThought?.();
      unsubUsage();
      unsubToolsReady();
      unsubTool();
      unsubStep();
      unsubDone();
      unsubError();
      unsubSubToken();
      unsubSubThought();
      unsubSubTool();
      unsubSubStep();
      unsubPlanNote();
      unsubModeChange();
      unsubAskQuestions();
      unsubToolConfirmRequired();
      unsubNoteUpdated();
      unsubTodos();
      unsubDoomLoop();
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
      window.electron?.piAgent.compactNow({
        sessionId: session.sessionId,
        config: {
          provider: agentConfig.baseUrl.includes("localhost") || agentConfig.baseUrl.includes("127.0.0.1") ? "localllm" : "openai",
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
    const commandMatch = trimmed.startsWith("/")
      ? registryCommands.find((c) => c.name === trimmed.slice(1).trim())
      : undefined;
    if (commandMatch) {
      setInput("");
      void window.electron?.runtime?.executeCommand({ sessionId: session.sessionId, line: trimmed });
      return;
    }

    setInput("");
    setIsLoading(true);
    setPendingQuestions(null);
    setPendingQuestionCallId(null);
    setDoomLoop(null);

    // Add user message to store (attachments rendered as thumbnails in transcript)
    addPiMessage(session.sessionId, {
      id:        id(),
      role:      "user",
      content:   trimmed,
      images:    attachments.length > 0 ? attachments.map((a) => ({ url: a.dataUrl, name: a.name, kind: a.kind })) : undefined,
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
        provider:   (agentConfig.baseUrl.includes("localhost") || agentConfig.baseUrl.includes("127.0.0.1")) ? "localllm" : "openai",
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
    window.electron?.piAgent.prompt(promptPayload);
  }, [isLoading, session, agentConfig, activeWorkspaceId, addPiMessage, setInput, enqueue]);

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
  const resolveDoomLoop = useCallback((allow: boolean) => {
    if (!doomLoop) return;
    const { sessionId } = session;
    window.electron?.piAgent.respondDoomLoop(sessionId, doomLoop.callId, allow);
    setDoomLoop(null);
  }, [doomLoop, session]);

  // Answers to a blocked ask_questions call. The formatted text is returned to
  // the loop as the tool result (opencode-style) rather than starting a new turn.
  const submitQuestions = useCallback((answersText: string) => {
    if (!pendingQuestionCallId) {
      // No blocked call (stale form) — fall back to a plain user message.
      void sendPrompt(answersText);
      return;
    }
    window.electron?.piAgent.respondQuestions(session.sessionId, pendingQuestionCallId, answersText);
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
    window.electron?.piAgent.abort(session.sessionId);
    finalisePiMessage(session.sessionId);
    setIsLoading(false);
    setPendingQuestions(null);
    setPendingQuestionCallId(null);
    setDoomLoop(null);
  }

  function handleClear() {
    if (isLoading) handleStop();
    // Clearing the conversation must also drop anything queued for it — the
    // drain effect (which fires when handleStop flips isLoading to false) would
    // otherwise immediately send the queued prompts into a cleared session.
    clearQueue();
    clearPiMessages(session.sessionId);
    setPiSessionTodos(session.sessionId, []);
    window.electron?.piAgent.clear(session.sessionId);
  }

  function handleApprovePlan(autoApprove: boolean) {
    if (!session.planNoteId || isLoading || !session.cwd) return;
    setPiAutoApprove(session.sessionId, autoApprove);
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
        provider:   (agentConfig.baseUrl.includes("localhost") || agentConfig.baseUrl.includes("127.0.0.1")) ? "localllm" : "openai",
        baseUrl:     agentConfig.baseUrl     || undefined,
        model:       agentConfig.model       || undefined,
        apiKey:      agentConfig.apiKey      || undefined,
        maxSteps:    agentConfig.maxSteps    ?? 30,
         // Same effective-temperature resolution as the prompt path.
         temperature: effectiveTemperatureForModel(agentConfig.model, agentConfig.temperature),
         contextWindow: agentConfig.contextLimit,
         maxTokens:   resolveMaxOutputTokens(
           agentConfig.maxOutputAuto === false ? agentConfig.maxOutputTokens : undefined,
           getModelInfo(agentConfig.model)?.maxOutput,
         ),
         autoApprove,
         isReasoningModel: getModelInfo(agentConfig.model)?.reasoning === true,
      },
    });
  }

  return (
    <div className="flex flex-col h-full bg-[var(--surface)]">

      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-[var(--border)] bg-[var(--surface-2)] flex-shrink-0">
        <span className="text-[0.714rem] text-[var(--text-tertiary)] truncate flex-1">
          {session.taskTitle !== "Ad-hoc session" ? session.taskTitle : project?.name ?? "Cairn Agent"}
        </span>

        {/* Mode badge */}
        {session.mode === "plan" ? (
          <button
            disabled={isLoading}
            onClick={() => window.electron?.piAgent.setMode(session.sessionId, "execute")}
            className="flex items-center gap-1 text-[0.643rem] font-semibold px-1.5 py-0.5 rounded-full bg-[color-mix(in_srgb,var(--warning,#f59e0b)_15%,transparent)] text-[var(--warning,#f59e0b)] hover:bg-[color-mix(in_srgb,var(--warning,#f59e0b)_25%,transparent)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <MapIcon size={9} />
            PLAN
          </button>
        ) : session.mode === "execute" ? (
          <button
            disabled={isLoading}
            onClick={() => window.electron?.piAgent.setMode(session.sessionId, "plan")}
            className="flex items-center gap-1 text-[0.643rem] font-semibold px-1.5 py-0.5 rounded-full bg-[var(--accent-dim)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Zap size={9} />
            EXECUTE
          </button>
        ) : null}

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


        {session.lastUsage && (
          <ContextRing
            promptTokens={session.lastUsage.promptTokens}
            contextLimit={normalizeContextLimit(agentConfig.contextLimit)}
            breakdown={session.lastUsage.breakdown}
            completionTokens={session.lastUsage.completionTokens}
            reasoningTokens={session.lastUsage.reasoningTokens}
            cacheReadTokens={session.lastUsage.cacheReadTokens}
            cacheCreationTokens={session.lastUsage.cacheCreationTokens}
            costUsd={session.lastUsage.costUsd}
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
      {/* Messages — virtualized so a session with thousands of persisted
          messages (each with reasoning, tool chips, subagent traces) only ever
          mounts the items near the viewport, no matter how far you scroll. */}
      <Virtuoso
        ref={virtuosoRef}
        className="flex-1 min-h-0"
        data={messages}
        initialTopMostItemIndex={Math.max(0, messages.length - 1)}
        followOutput={(isAtBottom) => (isAtBottom ? "smooth" : false)}
        components={{
          EmptyPlaceholder: () => (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-3">
              <p className="text-[0.786rem] font-medium text-[var(--text-secondary)]">
                {session.mode === "plan" ? "Plan Mode" : "Cairn Agent"}
              </p>
              <p className="text-[0.714rem] text-[var(--text-tertiary)] max-w-48">
                {session.mode === "plan"
                  ? "Describe what you want to build — I'll ask questions and draft a plan before writing any code."
                  : "Ask me to read, edit, or run code — or manage your project board."}
              </p>
            </div>
          ),
          Footer: () => (
            <div className="px-3 pb-3 space-y-3">
              {pendingQuestions && (
                <QuestionForm
                  questions={pendingQuestions}
                  onSubmit={submitQuestions}
                  disabled={false}
                />
              )}
              {doomLoop && (
                <div
                  data-testid="doom-loop-card"
                  className="w-full max-w-xl rounded-lg border border-[color-mix(in_srgb,var(--warning)_45%,var(--border))] bg-[color-mix(in_srgb,var(--warning)_6%,var(--surface))] px-3 py-2.5"
                >
                  <div className="flex items-start gap-2">
                    <Loader2 size={14} className="mt-0.5 text-[var(--warning)] animate-spin shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[0.786rem] font-medium text-[var(--text-primary)]">
                        The agent is repeating the same action
                      </p>
                      <p className="mt-0.5 text-[0.643rem] text-[var(--text-tertiary)]">
                        <span className="font-mono text-[var(--text-secondary)]">{doomLoop.toolName}</span> has been
                        called {doomLoop.count} times in a row with identical arguments — this looks like a loop.
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-end gap-1.5">
                    <button
                      data-testid="doom-loop-deny"
                      onClick={() => resolveDoomLoop(false)}
                      className="px-2 py-1 text-[0.643rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] rounded transition-colors"
                    >
                      Stop
                    </button>
                    <button
                      data-testid="doom-loop-allow"
                      onClick={() => resolveDoomLoop(true)}
                      className="px-2.5 py-1 text-[0.643rem] font-semibold text-[var(--accent-fg)] bg-[var(--accent)] hover:opacity-90 rounded transition-opacity"
                    >
                      Continue anyway
                    </button>
                  </div>
                </div>
              )}
            </div>
          ),
        }}
        itemContent={(_index, msg) => (
          <div className="px-3 pt-3">
            <AgentMessageBubble
              message={msg}
              sessionId={session.sessionId}
              connectors={connectorMap}
            />
          </div>
        )}
      />

      {/* Input — with upward-expanding plan task list docked above it */}
      <div className="border-t border-[var(--border)] flex-shrink-0">
        {/* Pinned status strip: always visible above the input even when the
            transcript is scrolled up. Shows the working state and the queued
            message count — the queue stays collapsed so full message content
            is only rendered when the user expands it. */}
        {isLoading && !pendingQuestions && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--surface)]">
            <Loader2 size={11} className="text-[var(--accent)] animate-spin shrink-0" />
            <span className="text-[0.714rem] text-[var(--text-secondary)]">
              Agent is working — you can queue messages below
            </span>
          </div>
        )}
        {queued.length > 0 && (
          <div className="border-b border-[var(--border)] bg-[var(--surface)]">
            <button
              type="button"
              onClick={() => setQueueExpanded((v) => !v)}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-[var(--surface-2)] transition-colors"
            >
              <Clock size={11} className="text-[var(--text-tertiary)] shrink-0" />
              <span className="text-[0.714rem] text-[var(--text-secondary)]">
                {queued.length} message{queued.length === 1 ? "" : "s"} queued — will send after the current run
              </span>
              <ChevronDown
                size={11}
                className={`ml-auto text-[var(--text-tertiary)] shrink-0 transition-transform ${queueExpanded ? "rotate-180" : ""}`}
              />
            </button>
            {queueExpanded && (
              <div className="px-3 pb-2 space-y-2">
                {queued.map((q) => (
                  <div key={q.id} className="flex items-start gap-2">
                    <span className="text-[0.714rem] text-[var(--text-secondary)] flex-1 min-w-0 line-clamp-2">
                      {q.content || (q.attachments && q.attachments.length > 0 ? "(attachment)" : "")}
                      {q.attachments && q.attachments.length > 0 && q.content ? ` · ${q.attachments.length} attachment${q.attachments.length === 1 ? "" : "s"}` : null}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeQueued(q.id)}
                      className="text-[0.643rem] text-[var(--text-tertiary)] hover:text-[var(--danger)] shrink-0 transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {session.mode === "plan" && planNoteContent && session.planNoteId && (
          <PlanApprovalCard
            content={planNoteContent}
            busy={isLoading}
            onApprove={handleApprovePlan}
            onRequestChanges={(feedback) => void sendPrompt(`Please revise the plan based on this feedback:\n\n${feedback}`)}
          />
        )}
        {session.mode === "execute" && planNoteContent && (
          <PlanTaskList content={planNoteContent} />
        )}
        {session.mode === "execute" && (sessionTodos?.length ?? 0) > 0 && (
          <AgentTodoDock todos={sessionTodos ?? []} live={false} />
        )}
      <div className="p-3">
        <ChatInputArea
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
