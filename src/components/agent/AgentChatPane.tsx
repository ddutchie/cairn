"use client";

/**
 * AgentChatPane — chat UI for Cairn native agent sessions.
 *
 * Rendered inside SessionPane when session.sessionType === "coding".
 * Subscribes to session:* IPC events and updates Zustand store.
 * Multi-turn: each new message continues the same session's history.
 */

import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore } from "react";
import { Trash2, FileText, Map as MapIcon } from "lucide-react";
import type { SuggestionItem } from "@/components/chat/ChatInput";
import type { PendingQuestion } from "@/components/conversation/conversation-message";
import { unwrapSessionPayload } from "@/components/conversation/conversation-session";
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
import { AgentJobsDock } from "./AgentJobsDock";
import { AgentGoalChip } from "./AgentGoalChip";
import type { GoalSummary } from "../../../shared/agent/session-projection";
import { Tooltip } from "@/components/ui/tooltip";
import { revealNote } from "@/lib/events";
import { isBenignTurnEnd } from "../../../shared/agent/turn-end-reason";
import { resolvePromptContext } from "@/lib/context-resolver";
import { useChatMessageQueue, useQueueDrain } from "@/hooks/useChatMessageQueue";
import { getModelInfo, prewarmModelCatalog, subscribeModelCatalog, getModelCatalogVersion, effectiveTemperatureForModel } from "@/lib/models-dev";
import { hasPromptFired, markPromptFired } from "@/lib/agent-prompt-guard";
import type { TerminalSession, TokenBreakdown, RegistryFetchResult } from "@/types";
import { redactAgentToolCall } from "@/lib/redact-agent-transcript";
import { toConversationMessage } from "@/components/conversation/conversation-message";
import { ConversationEmptyState } from "@/components/conversation/ConversationEmptyState";
import { ConversationPane } from "@/components/conversation/ConversationPane";
import { ConversationQueueDock, ConversationWorkingStatus, type ConversationQueuedItem } from "@/components/conversation/ConversationComposerParts";
import { SubagentCatalogAction } from "@/components/conversation/SubagentCatalogAction";
import { AgentPermissionSelect } from "./AgentPermissionSelect";
import type { SessionProjection } from "../../../shared/agent/session-projection";
import { useSessionConversation } from "@/hooks/useSessionConversation";

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
  const setSessionJobs           = useCairnStore((s) => s.setSessionJobs);
  const setView                  = useCairnStore((s) => s.setView);

  // Reactive state — only values that actually drive re-renders
  const { agentConfig, aiConfig, projects, activeWorkspaceId, mcpServers, customServices } = useCairnStore(useShallow((s) => ({
    agentConfig:       s.agentConfig,
    aiConfig:          s.aiConfig,
    projects:          s.projects,
    activeWorkspaceId: s.activeWorkspaceId,
    mcpServers:        s.mcpServers,
    customServices:    s.customServices,
  })));
  const sessionPresentation = useCairnStore((s) => s.sessionPresentation);
  const sessionTodos = useCairnStore((s) => s.sessionTodos[session.sessionId]);
  const sessionJobs = useCairnStore((s) => s.sessionJobs[session.sessionId]);
  const customCommands = useCairnStore((s) => s.customCommands);
  const registryCommands = useRegistryCommands();
  const agentCommands = useMemo(
    () => getCommandsForScope("agent", customCommands, registryCommands),
    [customCommands, registryCommands]
  );

  const messages = session.messages ?? [];
  const conversationMessages = useMemo(() => (session.messages ?? []).map((message) => toConversationMessage(message)), [session.messages]);

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
  // Live PRD note content — updated whenever the agent writes to the plan note
  const [planNoteContent, setPlanNoteContent]     = useState<string | null>(null);
  // Retry state — shown in status bar when the loop is backing off after a transient error
  const [retryInfo, setRetryInfo]                 = useState<{ attempt: number; maxRetries: number; delayMs: number } | null>(null);
  // Compaction state — shown in status bar while an LLM summary call is in flight
  const [isCompacting, setIsCompacting]           = useState(false);
  // Current same-session goal (dsh goal domain) — snapshot on mount, live via
  // session:projection kind:"goal". Null = no current goal → chip hides.
  const [sessionGoal, setSessionGoal]             = useState<GoalSummary | null>(null);
  const [connectorEntries, setConnectorEntries]   = useState<RegistryFetchResult["manifest"] | null>(null);

  // The shared controller owns canonical session:event folding and transport
  // filtering. Coding persistence remains an adapter because it is transcript-
  // oriented, unlike Chat's single assistant-message commit.
  const sessionConversation = useSessionConversation({
    sessionId: session.sessionId,
    adapter: {
      onTurnStart: () => { setIsLoading(true); finaliseAgentMessage(session.sessionId); },
      onText: (delta) => appendAgentToken(session.sessionId, delta),
      onReasoning: (delta) => appendAgentThought(session.sessionId, delta),
      onUsage: (usage) => updateAgentUsage(session.sessionId, usage.promptTokens, usage.completionTokens, usage.reasoningTokens, usage.breakdown as TokenBreakdown | undefined, usage.cacheReadTokens, usage.cacheCreationTokens),
      onToolCall: (call) => addAgentToolCall(session.sessionId, { callId: call.callId ?? `${call.name}:${Date.now()}`, name: call.name, label: call.name, ...(typeof call.view?.title === "string" && call.view.title ? { viewTitle: call.view.title } : {}), args: call.args, running: true, ok: true }),
      onToolResult: (result) => {
        if (!result.callId) return;
        updateAgentToolCall(session.sessionId, result.callId, { label: result.name, ...(result.resultView ? { resultView: result.resultView } : {}), args: result.args, running: false, ok: result.ok, output: READ_ONLY_TOOLS.has(result.name) ? undefined : redactAgentToolCall({ output: result.output }).output, cairnRef: extractCairnRef(result.name, result.output) });
      },
      onTurnEnd: (reason, _snapshot, detail) => {
        finaliseAgentMessage(session.sessionId); setIsLoading(false); setRetryInfo(null); setIsCompacting(false); sessionConversation.setQuestions(null);
        // `detail` carries the structured failure message; `reason` alone only
        // ever said "(error)" and hid the actual cause.
        if (reason && !isBenignTurnEnd(reason)) addAgentMessage(session.sessionId, { id: id(), role: "error", content: detail ?? `Agent turn ended abnormally (${reason})`, timestamp: new Date().toISOString() });
      },
    },
  });
  const { pendingQuestions, pendingQuestionCallId, pendingQuestionNonce } = sessionConversation as typeof sessionConversation & { pendingQuestionNonce?: string };

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
  // an idle input. The main process tracks the live loop (`session:is-running`)
  // — poll it once on mount. When it reports not-running, any assistant message
  // the previous mount left in a streaming state (it unmounted before
  // session:done) is stale — finalise it so no ghost bubble lingers.
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
        sessionConversation.setQuestions(pq.questions as PendingQuestion[], pq.callId, (pq as { nonce?: string }).nonce);
      }
      if (running) {
        setIsLoading(true);
        return;
      }
      // Not running: anything still streaming is stale — the loop ended while
      // this pane was unmounted (session:done was missed). Finalise it so no
      // ghost bubble lingers, and show the idle input.
      setIsLoading(false);
      finaliseAgentMessage(session.sessionId);
      setRetryInfo(null);
      sessionConversation.setQuestions(null);
    };
    void sync();
    return () => { cancelled = true; };
  // `sessionConversation.setQuestions` is ref-backed by the shared controller;
  // the hook result object is intentionally not a dependency because it is a
  // fresh view-model object on each render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId, finaliseAgentMessage, setAgentToolConfirmRequired]);

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

    // Initial goal snapshot (durable log fold — works before any live agent).
    // Clear the previous session's goal: this effect re-runs on session
    // switch and the new snapshot may take a moment to arrive.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSessionGoal(null);
    let cancelled = false;
    // A live goal projection is newer than the in-flight snapshot — once one
    // arrives, the pending snapshot must not clobber it when it settles.
    let liveUpdate = false;
    void electron.session.goal(sessionId).then((res) => {
      if (cancelled || liveUpdate) return;
      if (res && typeof res === "object" && "ok" in res && res.ok) {
        setSessionGoal((res as { value: GoalSummary | null }).value);
      }
    }).catch(() => undefined);

    const unsubProjection = electron.session.onProjection((projection: SessionProjection) => {
      if (projection.sessionId !== sessionId) return;
      const e = projection.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (projection.kind === "subagent-trace" && e.parentSession === sessionId) {
        if (e.trace === "token") appendAgentSubagentToken(sessionId, e.childId, e.delta);
        else if (e.trace === "thought") appendAgentSubagentThought(sessionId, e.childId, e.delta);
        else if (e.trace === "tool-call") addAgentSubagentToolCall(sessionId, e.childId, { callId: e.callId ?? `${e.tool}:${Date.now()}`, name: e.tool, label: e.label, args: e.args, running: true, ok: true });
        else if (e.trace === "tool-done") updateAgentSubagentToolCall(sessionId, e.childId, e.callId ?? `${e.tool}:unknown`, { label: e.tool, running: false, ok: e.ok ?? true, output: READ_ONLY_TOOLS.has(e.tool) ? undefined : redactAgentToolCall({ output: e.output }).output, cairnRef: e.cairnRef ?? extractCairnRef(e.tool, e.output) });
        else if (e.trace === "usage") updateAgentSubagentUsage(sessionId, e.childId, e.promptTokens, e.completionTokens, e.reasoningTokens ?? 0, e.breakdown as TokenBreakdown | undefined, e.cacheReadTokens, e.cacheCreationTokens);
        else if (e.trace === "status" && e.status === "done") { stepAgentSubagent(sessionId, e.childId); finaliseAgentSubagentMessage(sessionId, e.childId); }
        else if (e.trace === "status" && e.status === "start") addAgentSubagentToolCall(sessionId, e.childId, { callId: `${e.childId}:start`, name: "subagent", label: e.role ?? "subagent", running: false, ok: true });
        return;
      }
      if (projection.kind === "plan-note") { if (e.planContent) setPlanNoteContent(e.planContent); setAgentMode(sessionId, "plan", e.noteId); }
      else if (projection.kind === "mode-change") setAgentMode(sessionId, e.mode, e.planNoteId);
      else if (projection.kind === "approval") setAgentToolConfirmRequired(sessionId, e.callId, e.status === "required", e.nonce);
      else if (projection.kind === "note-updated") {
        const planId = useCairnStore.getState().terminalSessions.find((t) => t.sessionId === sessionId)?.planNoteId;
        if (planId && e.noteId === planId) setPlanNoteContent(e.content);
      } else if (projection.kind === "todos") setSessionTodos(sessionId, e.todos as never);
      else if (projection.kind === "jobs") {
        // Bridge emits the owner's full visible set (owned + unowned); the
        // dock filters to this session's jobs plus unowned ones.
        const jobs = (e.jobs ?? []) as { ownerSession?: string }[];
        setSessionJobs(sessionId, jobs.filter((j) => j.ownerSession == null || j.ownerSession === sessionId) as never);
      }
      else if (projection.kind === "goal") { liveUpdate = true; setSessionGoal((e.goal ?? null) as GoalSummary | null); }
      else if (projection.kind === "retry") { setRetryInfo({ attempt: e.attempt, maxRetries: e.maxRetries, delayMs: e.delayMs }); setTimeout(() => setRetryInfo(null), e.delayMs + 500); }
      else if (projection.kind === "compact") { setIsCompacting(e.status === "start"); if (e.status === "end" && e.auto) addAgentMessage(sessionId, { id: id(), role: "system" as const, content: "----- Session Compacted -----", timestamp: new Date().toISOString() }); }
      else if (projection.kind === "compact-result") {
        void (async () => {
          try {
            const result = await (electron.session as unknown as { getSessionMessages: (id: string) => Promise<unknown> }).getSessionMessages(sessionId);
            const rows = unwrapSessionPayload(result).messages;
            if (rows.length) useCairnStore.setState((s) => ({ terminalSessions: s.terminalSessions.map((t) => t.sessionId === sessionId ? { ...t, messages: rows as never } : t) }));
          } catch (err) { console.warn("[AgentChatPane] compact reload failed", err); }
          addAgentMessage(sessionId, { id: id(), role: "system" as const, content: e.messageCount > 0 ? `Context compacted — session history summarised into ${e.messageCount} messages.` : "Nothing to compact — session history is too short.", timestamp: new Date().toISOString() });
        })();
      }
    });

    return () => {
      cancelled = true;
      unsubProjection();
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
          // Pin the summariser protocol to this provider's apiMode so compaction
          // never mounts a different api than the live turns (replay stays valid).
          apiMode: (aiConfig.savedProviders?.find((p) => p.id === agentConfig.activeProviderId)?.apiMode) ?? "completions",
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
    sessionConversation.startPrompt(() => undefined);
    sessionConversation.setQuestions(null);

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
      profile:     session.role === "automation-dev" ? "automation-dev" : "coding",
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
          ...(() => {
            const effectiveMode = (agentConfig as { mode?: import("../../../shared/agent/approval-mode").Mode }).mode
              ?? (session.autoApprove !== undefined ? (session.autoApprove ? "auto" as const : "interactive" as const) : agentConfig.autoApprove ? "auto" as const : "interactive" as const);
            return { mode: effectiveMode, autoApprove: effectiveMode === "auto" };
          })(),
          // Reasoning models get the `developer` system role (OpenAI convention).
          isReasoningModel: getModelInfo(agentConfig.model)?.reasoning === true,
          // Only send reasoning effort to reasoning-capable models, and only when
          // the user pinned a concrete level — "auto"/unset sends NO override so
          // the model/provider default applies. Non-reasoning models never get it.
          reasoningEffort: (getModelInfo(agentConfig.model)?.reasoning === true && agentConfig.reasoningEffort && agentConfig.reasoningEffort !== "auto")
            ? agentConfig.reasoningEffort
            : undefined,
          // Explicit wire protocol pinned on the agent's active saved provider
          // (default completions) — never auto-probed, so resumed coding sessions
          // stay on a stable protocol across restarts.
          apiMode: (aiConfig.savedProviders?.find((p) => p.id === agentConfig.activeProviderId)?.apiMode) ?? "completions",
       },
    };
    window.electron?.session.prompt(promptPayload);
  }, [isLoading, session, agentConfig, aiConfig, activeWorkspaceId, addAgentMessage, setInput, enqueue, registryCommands, sessionConversation]);

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
    window.electron?.session.respondQuestions(session.sessionId, pendingQuestionCallId, answersText, pendingQuestionNonce);
    sessionConversation.setQuestions(null);
  }, [pendingQuestionCallId, pendingQuestionNonce, session, sendPrompt, sessionConversation]);

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
      console.error("[session:autocomplete] searchFiles failed:", err);
      return [];
    }
  }, [session.cwd]);

  function handleStop() {
    sessionConversation.stop();
    finaliseAgentMessage(session.sessionId);
    setIsLoading(false);
    sessionConversation.setQuestions(null);
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
    <ConversationPane
      className="h-full bg-[var(--surface)]"
      sessionId={session.sessionId}
      profile={session.role === "automation-dev" ? "automation-dev" : "coding"}
      messages={conversationMessages}
      input={input}
      onInputChange={setInput}
      onPrompt={sendPrompt}
      onAbort={handleStop}
      isLoading={isLoading}
      transcriptRef={virtuosoRef}
      composerRef={textareaRef}
      usage={session.lastUsage}
      contextLimit={normalizeContextLimit(agentConfig.contextLimit)}
      connectors={connectorMap}
      centered={sessionPresentation === "center"}
      title={session.taskTitle !== "Ad-hoc session" ? session.taskTitle : project?.name ?? "Cairn Agent"}
      emptyState={(
        <ConversationEmptyState
          title={session.mode === "plan" ? "Plan Mode" : "Cairn Agent"}
          description={session.mode === "plan"
            ? "Describe what you want to build — I'll ask questions and draft a plan before writing any code."
            : "Ask me to read, edit, or run code — or manage your project board."}
        />
      )}
      projection={{ pendingQuestions }}
      onAnswerQuestions={submitQuestions}
      transcriptFooter={() => <div className="px-3 pt-3 pb-3 space-y-3" />}
      actions={(
        <>
          {/* Permission preset (dsh permission-presets select) — hidden until
              the presets service is active. No approval-mode toggle exists in
              this pane; this row (PLAN badge, PRD, clear) is the session-control
              home, so the switcher lives here. Keyed by session so a switch
              never flashes the previous session's preset. */}
          <AgentPermissionSelect key={session.sessionId} sessionId={session.sessionId} />
          <SubagentCatalogAction parentSessionId={session.sessionId} />
          {session.mode === "plan" && <span className="flex items-center gap-1 text-[0.643rem] font-semibold px-1.5 py-0.5 rounded-full bg-[color-mix(in_srgb,var(--warning,#f59e0b)_15%,transparent)] text-[var(--warning,#f59e0b)]"><MapIcon size={9} /> PLAN</span>}
          {session.planNoteId && <Tooltip content="Open plan note" side="left"><button onClick={() => revealNote(setView, session.planNoteId!)} className="flex items-center gap-1 text-[0.643rem] text-[var(--text-secondary)] hover:text-[var(--text-primary)] px-1.5 py-0.5 rounded-full border border-[var(--border)] hover:bg-[var(--surface-2)] transition-colors"><FileText size={9} /> PRD</button></Tooltip>}
          <Tooltip content="Clear conversation" side="left"><button onClick={handleClear} className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"><Trash2 size={12} /></button></Tooltip>
        </>
      )}
      composerBefore={(
        <div className={cn("flex-shrink-0", sessionPresentation === "center" && "max-w-3xl mx-auto w-full")}>
          {isLoading && !pendingQuestions && <ConversationWorkingStatus label="Agent is working — you can queue messages below" />}
          <ConversationQueueDock items={queued as ConversationQueuedItem[]} expanded={queueExpanded} onToggle={() => setQueueExpanded((v) => !v)} onRemove={removeQueued} noun="message" />
          {session.mode === "execute" && planNoteContent && <PlanTaskList content={planNoteContent} />}
          <AgentGoalChip goal={sessionGoal} />
          {session.mode === "execute" && (sessionTodos?.length ?? 0) > 0 && <AgentTodoDock todos={sessionTodos ?? []} live={false} />}
          {(sessionJobs?.length ?? 0) > 0 && <AgentJobsDock jobs={sessionJobs ?? []} sessionId={session.sessionId} />}
        </div>
      )}
      composerProps={{
        centered: sessionPresentation === "center",
        queueWhileBusy: isLoading,
        queuedCount: queued.length,
        commands: agentCommands,
        onSearchSuggestions: handleSearchFiles,
        allowImages,
        allowPdf,
        providerModelTarget: "agent",
        statusText: retryInfo ? `Transient error — retrying (${retryInfo.attempt}/${retryInfo.maxRetries}) in ${Math.round(retryInfo.delayMs / 1000)}s…` : pendingQuestions ? "Waiting for your answers…" : isCompacting ? "Compacting context…" : isLoading ? "Working… click ◼ to stop" : "Shift+Enter for new line · Enter to send",
      }}
    />
  );
}
