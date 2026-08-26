"use client";

import React, { useState, useRef, useEffect, useMemo, useCallback, useSyncExternalStore } from "react";
import { type VirtuosoHandle } from "react-virtuoso";
import { Trash2, ChevronDown, ArrowLeftFromLine, History } from "lucide-react";
import { useCairnStore } from "@/store";
import { chatSessionId } from "../../../../shared/agent/session-identity";
import { useShallow } from "zustand/react/shallow";
import { useChatStream } from "@/hooks/useChatStream";
import type { ChatToolCall, PendingQuestion } from "@/hooks/useChatStream";
import { useChatMessageQueue, useQueueDrain, type QueuedMessage } from "@/hooks/useChatMessageQueue";
import { buildGraphContext } from "@/components/graph/graph-ai-utils";
import { ipcAwaitResult } from "@/store/ipc";
import { resolvePromptContext } from "@/lib/context-resolver";
import { storage } from "@/lib/storage";
import { ACTIVE_PROJECT_KEY } from "@/lib/constants";

import type { ChatHistoryEntry, ChatSubagent } from "@/types";

import { Tooltip } from "@/components/ui/tooltip";
import { ChatFooterSlot } from "@/lib/plugin-ui/SlotOutlet";
import type { SuggestionItem } from "../ChatInput";
import { ChatQuickSettings } from "./ChatQuickSettings";
import { SuggestedPrompts } from "./SuggestedPrompts";
import { ToolCallIndicator } from "./ToolCallIndicator";
import { useCommunityConnectorMap, type ChatConnectorMeta } from "./connector-context";
import { ConversationEmptyState } from "@/components/conversation/ConversationEmptyState";
import { getCommandsForScope } from "@/lib/slash-commands";
import { useRegistryCommands } from "@/hooks/useRegistryCommands";
import { cn, id } from "@/lib/utils";
import { ChatTimeline, deriveSpansFromMessages } from "../ChatTimeline";
import {
  getModelInfo,
  getModelCatalogVersion,
  prewarmModelCatalog,
  subscribeModelCatalog,
  effectiveTemperatureForModel,
} from "@/lib/models-dev";
import { supportsImageInput, resolveMaxOutputTokens } from "../../../../shared/models/model-catalog";
import { supportsPdfInput } from "../../../../shared/models/pdf-attach";
import { toConversationMessage } from "@/components/conversation/conversation-message";
import { toConversationSubagent } from "@/components/conversation/conversation-message";
import { ConversationSubagentBlock } from "@/components/conversation/ConversationSubagentBlock";
import { ActionsList } from "./ActionsList";
import { ConversationQueueDock, ConversationWorkingStatus, type ConversationQueuedItem } from "@/components/conversation/ConversationComposerParts";
import { ConversationPane } from "@/components/conversation/ConversationPane";

const GRAPH_SYSTEM_PROMPT = `You are a Knowledge Graph assistant embedded in Cairn, a note-taking and project management app.

You help users build meaningful connections between their notes, tasks, and projects. You have access to a snapshot of their current knowledge graph — each node includes its ID and title.

## RENDERING CAPABILITIES:
- You have access to the following markdown rendering features:
  - **Mermaid Diagrams**: Use \`\`\`mermaid\`\`\` blocks for flowcharts, sequence diagrams, etc.
  - **Tables**: Use standard markdown table syntax for data representation.
  - **Code Blocks**: Specify the language (e.g., \`\`\`typescript\`\`\`) for syntax highlighting.
  - **Standard Formatting**: Bold, italic, bulleted/numbered lists, and links.

## GETTING COMPLETE CONTEXT & EXISTING CONNECTIONS FIRST (CRITICAL):
- The graph snapshot provided in the prompt is **TRUNCATED** to conserve context tokens. It lists at most 80 nodes and 60 wikilinks.
- **BEFORE proposing any connection suggestions**, check if the workspace has more nodes/edges than shown in the snapshot. If the snapshot lists "(none)", shows truncated counts, or you suspect there are more existing notes/connections, **you MUST call \`get_knowledge_graph\` first** to fetch the full, comprehensive list of nodes and relationships.
- Proposing duplicate links that already exist is a system violation. Always check the full list of existing links/edges using \`get_knowledge_graph\` first to be absolutely certain you aren't suggesting a connection that already exists.

# CRITICAL MANDATE ON TOOL CALLS:
- **YOU MUST CALL THE \`suggest_connections\` TOOL** whenever you propose any connection (adding a wikilink, linking two notes, linking a note to a task card, or tagging).
- **NEVER merely describe suggested connections in your prose.** If you recommend a link or tag, you **must** emit it via a \`suggest_connections\` tool call. The user cannot click or apply prose text; they need the interactive tool-generated cards.
- **PROSE LIMITATION:** Use your prose *only* to explain high-level insights, structural analysis, patterns, or clusters. Do not duplicate the connection details as a standard markdown list of bullet points in your chat bubble — the UI will render interactive one-click "Apply" buttons for each action you send via the tool.
- Use node IDs exactly as they appear in the graph snapshot or from the \`get_knowledge_graph\` tool call. Limit to 8 connection actions maximum per tool call.

## Action Types in \`suggest_connections\`:
1. **\`add_wikilink\`**: Inserts [[targetTitle]] into \`sourceNoteId\`.
   - *Check duplicates:* Never suggest \`add_wikilink\` for connections that already exist.
2. **\`link_note_note\`**: Bidirectional connection between two notes.
3. **\`link_note_card\`**: Connection between a note and a task card.
4. **\`add_tag\`**: Adds tag name \`tagName\` to note or card.

Remember: Suggest connections actively. Call \`suggest_connections\` whenever there is even a potential relationship to explore!`;

interface ChatPanelProps {
  prefill?: { text: string; autoSend?: boolean } | null;
  onPrefillConsumed?: () => void;
  popoutMode?: boolean;
}

/**
 * Streaming Footer context.
 *
 * The Virtuoso `components.Footer` must be a STABLE module-scope reference: an
 * inline arrow function gets a new identity every render, so Virtuoso
 * unmounts/remounts the whole Footer (and the streaming thinking panel inside
 * it) on every streamed token — resetting its scroll and any collapse/expand.
 * So we render a stable Footer component that consumes this context, and
 * ChatPanel re-renders it reactively via the provider value. The Footer lives
 * INSIDE the Virtuoso scroller, so it grows downward in the scroll flow with
 * the list's padding.
 */
interface StreamingFooterValue {
  isLoading: boolean;
  pendingQuestions: PendingQuestion[] | null;
  subagents: ChatSubagent[];
  toolCalls: ChatToolCall[];
  streamingContent: string;
  streamingThought: string;
  connectorMap: Record<string, ChatConnectorMeta> | undefined;
  activeView: string;
  handleSend: ((text?: string, attachments?: never[]) => void) | null;
  /** Answer a blocking ask_questions same-turn (Cordis); false = not blocking. */
  answerQuestions?: (answersJson: string) => boolean;
}
const StreamingFooterContext = React.createContext<StreamingFooterValue>({
  isLoading: false,
  pendingQuestions: null,
  subagents: [],
  toolCalls: [],
  streamingContent: "",
  streamingThought: "",
  connectorMap: undefined,
  activeView: "",
  handleSend: null,
});

/** Stable Footer — rendered inside the Virtuoso so it grows downward in the
 *  scroll flow with the list's padding, but never remounts while streaming
 *  (consumes the context above, so it re-renders on each token reactively). */
function ChatFooter() {
  const s = React.useContext(StreamingFooterContext);
  const handleSend = s.handleSend;
  return (
    <div className={cn("px-3 py-3 space-y-3", s.activeView === "chat" && "max-w-3xl mx-auto w-full")}>
      {s.isLoading && s.subagents.length > 0 && (
        <div className="flex flex-col gap-1">
          {s.subagents.map((sub) => (
            <ConversationSubagentBlock key={sub.childId} subagent={toConversationSubagent(sub)} />
          ))}
        </div>
      )}
      {s.isLoading && (
        <ToolCallIndicator
          toolCalls={s.toolCalls}
          streamingContent={s.streamingContent}
          streamingThought={s.streamingThought}
          connectors={s.connectorMap}
        />
      )}
      {/* The pending-question form is rendered by ConversationPane (just above
          the composer, its canonical location). Do NOT also render it here in
          the transcript footer — doing so showed the ask_questions form twice
          (one inert copy in the scroll flow + the active one above the composer). */}
    </div>
  );
}

export function ChatPanel({ prefill, onPrefillConsumed, popoutMode }: ChatPanelProps = {}) {
  const {
    chatOpen,
    activeProjectId, activeWorkspaceId,
    projects, workspaces,
    addMessage,
    chatMessages, chatThreads, aiConfig,
    chatPanelWidth,
    activeView, graphData, selectedGraphNodeId,
    clearThreadMessages,
    createNote,
    notes, cards,
    activeChatThreadId, setActiveChatThreadId,
    setActiveProject,
    customCommands,
  } = useCairnStore(useShallow((s) => ({
    chatOpen:              s.chatOpen,
    activeProjectId:       s.activeProjectId,
    activeWorkspaceId:     s.activeWorkspaceId,
    projects:              s.projects,
    workspaces:            s.workspaces,
    addMessage:            s.addMessage,
    chatMessages:          s.chatMessages,
    chatThreads:           s.chatThreads,
    aiConfig:              s.aiConfig,
    chatPanelWidth:        s.chatPanelWidth,
    activeView:            s.activeView,
    graphData:             s.graphData,
    selectedGraphNodeId:   s.selectedGraphNodeId,
    clearThreadMessages:   s.clearThreadMessages,
    createNote:            s.createNote,
    notes:                 s.notes,
    cards:                 s.cards,
    activeChatThreadId:    s.activeChatThreadId,
    setActiveChatThreadId: s.setActiveChatThreadId,
    setActiveProject:      s.setActiveProject,
    customCommands:        s.customCommands,
  })));

  // threadId is driven by the store so the tab bar can switch threads externally
  const threadId = activeChatThreadId;
  const connectorMap = useCommunityConnectorMap();

  const [input, setInput] = useState("");
  const handleSendRef = useRef<(text?: string, attachments?: Array<{ kind: "image" | "pdf"; name: string; dataUrl: string }>) => Promise<void>>(async () => {});
  // Messages the user queued while a turn was running — sent (FIFO) when the
  // current reply finishes. Each item carries the thread + attachments captured
  // at enqueue time so a thread switch or queued images/PDFs are never lost.
  // Session-scoped; cleared on thread switch.
  const { queued, queueExpanded, setQueueExpanded, enqueue, removeQueued, clearQueue, drainNext } = useChatMessageQueue<QueuedMessage>();
  const registryCommands = useRegistryCommands();
  const chatCommands = useMemo(
    () => getCommandsForScope("chat", customCommands, registryCommands),
    [customCommands, registryCommands]
  );
  // Virtualized transcript handle — used to jump to the newest message when the
  // panel activates or a question form appears (followOutput handles streaming).
  const chatVirtuosoRef = useRef<VirtuosoHandle>(null);
  const inputRef       = useRef<HTMLTextAreaElement>(null);
  const projectRef     = useRef<HTMLDivElement>(null);
  const [projectOpen, setProjectOpen] = useState(false);

  // Warm the models.dev catalog on mount (also feeds image-input gating and the
  // model picker's cost/logo rows). Re-render when the catalog arrives.
  useEffect(() => { prewarmModelCatalog(); }, []);
  useSyncExternalStore(subscribeModelCatalog, getModelCatalogVersion);
  const allowImages = supportsImageInput(getModelInfo(aiConfig.model));
  const allowPdf = supportsPdfInput(getModelInfo(aiConfig.model));

  const { isLoading, toolCalls, streamingContent, streamingThought, subagents, pendingQuestions, sendStream, stopStream, clearQuestions, answerQuestions } = useChatStream(threadId);

  const project   = useMemo(() => projects.find((p) => p.id === activeProjectId),   [projects, activeProjectId]);
  const workspace = useMemo(() => workspaces.find((w) => w.id === activeWorkspaceId), [workspaces, activeWorkspaceId]);

  const selectedNode = useMemo(() => {
    if (!selectedGraphNodeId) return null;
    return graphData.nodes.find((n) => n.id === selectedGraphNodeId) || null;
  }, [graphData.nodes, selectedGraphNodeId]);

  const graphPrompts = useMemo(() => {
    if (selectedNode) {
      return [
        `What nodes are related to "${selectedNode.title}"?`,
        `Why is "${selectedNode.title}" connected to this cluster?`,
        `Find missing connections for "${selectedNode.title}"`,
        `Explain the structure around "${selectedNode.title}"`,
      ];
    }
    return [
      "What connections am I missing in this graph?",
      "Analyze this knowledge graph structure",
      "Find orphan notes or unlinked tasks",
      "Suggest new tags to organize this graph",
    ];
  }, [selectedNode]);

  const activeThread = useMemo(
    () => chatThreads.find((t) => t.id === threadId),
    [chatThreads, threadId]
  );

  const mentionSuggestions = useMemo<SuggestionItem[]>(() => {
    const projectNotes = notes.filter((n) => n.workspaceId === activeWorkspaceId && (!activeProjectId || n.projectId === activeProjectId) && !n.archivedAt);
    const projectCards = cards.filter((c) => c.workspaceId === activeWorkspaceId && (!activeProjectId || c.projectId === activeProjectId) && !c.archivedAt);
    
    const items: SuggestionItem[] = [];
    for (const note of projectNotes) {
      items.push({ id: note.id, type: "note", title: note.title, subtitle: "Note" });
    }
    for (const card of projectCards) {
      items.push({ id: card.id, type: "card", title: card.title, subtitle: `Task - ${card.priority}` });
    }
    return items;
  }, [notes, cards, activeWorkspaceId, activeProjectId]);

  const handleClear = useCallback(async () => {
    if (!threadId) return;
    // Preserve project context across the clear (the "lose project context after
    // clear" bug — after a clear the next turn's req.projectId was null because
    // the in-memory Cordis session was not remounted with the thread's project).
    const thread = useCairnStore.getState().chatThreads.find((t) => t.id === threadId);
    const projectIdToRestore = thread?.projectId ?? activeProjectId ?? null;
    const workspaceIdToRestore = thread?.workspaceId ?? activeWorkspaceId ?? null;
    clearQueue();
    if (isLoading) stopStream();
    clearQuestions();
    await clearThreadMessages(threadId);
    // Restore the thread's project/workspace so the next turn's get_active_context
    // and project-scoped tools still resolve (clearThreadMessages keeps the thread
    // row but the in-memory Context's per-turn mount would otherwise lose it).
    if (projectIdToRestore) {
      const cur = useCairnStore.getState().activeProjectId;
      if (cur !== projectIdToRestore) {
        useCairnStore.setState({ activeProjectId: projectIdToRestore });
        try { storage.set(ACTIVE_PROJECT_KEY, projectIdToRestore); } catch {}
      }
    }
    if (workspaceIdToRestore) {
      const curWs = useCairnStore.getState().activeWorkspaceId;
      if (curWs !== workspaceIdToRestore) {
        useCairnStore.setState({ activeWorkspaceId: workspaceIdToRestore });
      }
    }
  }, [threadId, isLoading, stopStream, clearThreadMessages, clearQuestions, clearQueue, activeProjectId, activeWorkspaceId]);

  const handleArchiveChat = useCallback(async () => {
    if (!threadId) return;
    if (isLoading) stopStream();

    const threadMessages = chatMessages.filter((m) => m.threadId === threadId);
    if (threadMessages.length === 0) {
      addMessage(threadId, "system", "Error: No messages to archive.");
      return;
    }

    if (!activeProjectId) {
      addMessage(threadId, "system", "Error: No active project selected. Please select a project before archiving the chat.");
      return;
    }

    addMessage(threadId, "system", "Archiving conversation to project note...");

    const history = threadMessages.map((m) => ({ role: m.role, content: m.content }));

    let noteContent = "";
    let useSummary = false;

    try {
      const result = await ipcAwaitResult<{ summary: string }>(async (e) => {
        try {
          const summaryObj = await e.chat.compactThread({
            messages: history,
            config: {
              provider: aiConfig.provider,
              baseUrl: aiConfig.baseUrl,
              model: aiConfig.model,
              apiKey: aiConfig.apiKey,
            },
          }) as { summary: string };
          return { data: summaryObj };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      });

      if (result && "data" in result && result.data?.summary) {
        const summary = result.data.summary;
        const threadTitle = activeThread?.title ?? (threadMessages.find((m) => m.role === "user")?.content.slice(0, 50) ?? "New thread");
        const dateStr = new Date().toLocaleString();
        
        noteContent = `# Chat Summary: ${threadTitle}\n\n` +
          `- **Date:** ${dateStr}\n` +
          `- **Original Thread:** ${threadTitle}\n\n` +
          `---\n\n` +
          summary;
        useSummary = true;
      }
    } catch (err) {
      console.warn("Failed to generate AI summary, falling back to raw transcript:", err);
    }

    if (!useSummary) {
      // Fallback: raw transcript
      const threadTitle = activeThread?.title ?? (threadMessages.find((m) => m.role === "user")?.content.slice(0, 50) ?? "New thread");
      const dateStr = new Date().toLocaleString();
      
      let rawTranscript = `# Chat Log: ${threadTitle}\n\n` +
        `- **Date:** ${dateStr}\n` +
        `- **Status:** Archive Fallback (AI Compaction Unavailable)\n\n` +
        `---\n\n` +
        `### Conversation History\n\n`;

      for (const msg of threadMessages) {
        if (msg.role === "system") continue;
        const roleName = msg.role === "user" ? "User" : "AI Assistant";
        rawTranscript += `### **${roleName}**\n\n${msg.content}\n\n`;
      }
      noteContent = rawTranscript;
    }

    // Determine note title with timestamp
    const nowObj = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const timestamp = `${nowObj.getFullYear()}-${pad(nowObj.getMonth() + 1)}-${pad(nowObj.getDate())}-${pad(nowObj.getHours())}${pad(nowObj.getMinutes())}${pad(nowObj.getSeconds())}`;
    
    const threadTitle = activeThread?.title ?? (threadMessages.find((m) => m.role === "user")?.content.slice(0, 50) ?? "New thread");
    const sluggedTitle = threadTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "");
    const noteTitle = `${timestamp}-${sluggedTitle || "conversation"}`;

    // Create the note
    createNote(activeProjectId, noteTitle, "note", "conversations", noteContent);

    // Clear the chat messages
    await clearThreadMessages(threadId);

    // Add a final system message confirming the save
    addMessage(threadId, "system", `Chat archived to project note: \`conversations/${noteTitle}\`.`);

  }, [threadId, isLoading, stopStream, chatMessages, activeProjectId, activeThread, aiConfig, addMessage, createNote, clearThreadMessages]);

  // Track isLoading in a ref so the thread-init effect can read it without
  // being listed as a dependency (we never want a loading-state change to
  // re-trigger thread selection).
  const isLoadingRef = useRef(isLoading);
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);

  // A queue belongs to the thread that was active when its messages were
  // written — switching threads drops anything still pending.
  useEffect(() => { clearQueue(); }, [threadId, clearQueue]);



  // Initialise / switch thread when the project changes.
  // When the user switches projects, the active chat thread should follow —
  // if the current thread belongs to a different project, find or create one
  // scoped to the new project. Never switches while a stream is in-flight.
  const prevProjectIdRef = useRef<string | null | undefined>(activeProjectId);
  const prevWorkspaceIdRef = useRef<string | null | undefined>(activeWorkspaceId);
  useEffect(() => {
    if (!activeWorkspaceId) return;
    if (isLoadingRef.current) return;

    const prevProject = prevProjectIdRef.current;
    const prevWorkspace = prevWorkspaceIdRef.current;
    prevProjectIdRef.current = activeProjectId;
    prevWorkspaceIdRef.current = activeWorkspaceId;

    const projectOrWorkspaceChanged =
      prevWorkspace !== activeWorkspaceId || prevProject !== activeProjectId;

    // If within the same project and workspace, preserve user selection
    if (!projectOrWorkspaceChanged && activeChatThreadId) {
      const currentThread = useCairnStore.getState().chatThreads.find(
        (t) => t.id === activeChatThreadId,
      );
      if (currentThread && currentThread.workspaceId === activeWorkspaceId) {
        if (activeProjectId ? currentThread.projectId === activeProjectId : !currentThread.projectId) {
          return;
        }
      }
    }

    // When switching project/workspace or starting up, pick the most recent thread scoped to this project:
    const candidates = useCairnStore.getState().chatThreads
      .filter((t) => t.workspaceId === activeWorkspaceId && (activeProjectId ? t.projectId === activeProjectId : !t.projectId))
      .sort((a, b) => {
        const aHas = useCairnStore.getState().chatMessages.some((m) => m.threadId === a.id);
        const bHas = useCairnStore.getState().chatMessages.some((m) => m.threadId === b.id);
        if (aHas !== bHas) return bHas ? 1 : -1;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });

    if (candidates.length > 0) {
      setActiveChatThreadId(candidates[0].id);
      return;
    }

    const t = useCairnStore.getState().getOrCreateThread(activeWorkspaceId, activeProjectId ?? undefined);
    setActiveChatThreadId(t.id);
  }, [activeWorkspaceId, activeProjectId, activeChatThreadId, setActiveChatThreadId]);



  const messages = useMemo(
    () => (threadId ? chatMessages.filter((m) => m.threadId === threadId) : []),
    [threadId, chatMessages],
  );
  const conversationMessages = useMemo(
    () => messages.map((message) => toConversationMessage(message, message.actions && message.actions.length > 0 ? <ActionsList actions={message.actions} /> : undefined)),
    [messages],
  );

  const [timelineOpen, setTimelineOpen] = useState(false);
  const [timelineRange, setTimelineRange] = useState<{ start: number; end: number } | null>(null);
  const timelineSpans = useMemo(() => deriveSpansFromMessages(messages as unknown as Array<{ role: string; toolCalls?: unknown[]; reasoning?: string }>), [messages]);
  const visibleMessages = useMemo(() => {
    if (!timelineRange) return messages;
    const n = messages.length;
    if (n === 0) return messages;
    const s = Math.floor(timelineRange.start * n);
    const e = Math.ceil(timelineRange.end * n);
    return messages.slice(s, e);
  }, [messages, timelineRange]);

  const isChatActive = useCairnStore((s) => s.activeSessionId === "chat");

  // Scroll to the bottom when messages/loading change, and whenever the
  // ask_questions form appears — otherwise it can land out of view if the user
  // had scrolled up when the model asked its questions. `pendingQuestions` is
  // an array, so depend on its length (a scalar) to avoid a deps-change warning.
  const pendingQuestionCount = pendingQuestions?.length ?? 0;
  // Jump to the newest message when the panel activates or the ask_questions
  // form appears — otherwise it can land out of view if the user had scrolled
  // up. Streaming follow is handled by Virtuoso's followOutput (only follows
  // while the user is at the bottom), so this deliberately does NOT depend on
  // messages.length — a new message must not yank a user who scrolled up.
  const chatMessagesLengthRef = useRef(messages.length);
  useEffect(() => { chatMessagesLengthRef.current = messages.length; }, [messages.length]);
  useEffect(() => {
    // chatMessagesLengthRef is read imperatively — messages.length intentionally
    // absent from deps so a new message never yanks a scrolled-up user.
    const count = chatMessagesLengthRef.current;
    if (isChatActive && chatVirtuosoRef.current && count > 0) {
      chatVirtuosoRef.current.scrollToIndex({ index: count - 1, align: "end", behavior: "smooth" });
    }
  }, [isChatActive, pendingQuestionCount]);
  useEffect(() => { if (chatOpen) inputRef.current?.focus(); }, [chatOpen]);

  const handleSend = useCallback(async (text?: string, attachments: Array<{ kind: "image" | "pdf"; name: string; dataUrl: string }> = []) => {
    const content = text ?? input.trim();
    if ((!content || !content.trim()) && attachments.length === 0) return;
    let targetThreadId: string | null = threadId;
    if (!targetThreadId && activeWorkspaceId) {
      const t = useCairnStore.getState().getOrCreateThread(activeWorkspaceId, activeProjectId ?? undefined);
      targetThreadId = t.id;
      setActiveChatThreadId(t.id);
    }
    if (!targetThreadId) return;

    // A turn is already running — queue this message instead of interrupting it.
    // The queue drains (FIFO) when the current reply finishes. Attachments are
    // queued alongside the text so staged images/PDFs are never silently dropped.
    if (isLoadingRef.current) {
      if (!content.trim() && attachments.length === 0) return;
      enqueue({ id: id(), content, threadId: targetThreadId!, attachments });
      setInput("");
      return;
    }

    const trimmed = content.trim();
    if (!attachments.length) {
      if (trimmed === "/compact" || trimmed === "/ compact") {
        setInput("");
        useCairnStore.getState().compactChatThread(targetThreadId!);
        return;
      }

      if (trimmed === "/archive-chat" || trimmed === "/archive" || trimmed === "/ archive-chat" || trimmed === "/ archive") {
        setInput("");
        handleArchiveChat();
        return;
      }

      // Other dsh registry commands (e.g. /plan from a future chat surface,
      // plugin commands) execute through the runtime on this thread's agent.
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
        void window.electron?.runtime?.executeCommand({ sessionId: `chat-${targetThreadId}`, line: trimmed }).then((result) => {
          if (commandName === "plan" && commandArgs && commandArgs !== "off" && result?.kind === "success") {
            void handleSendRef.current(commandArgs);
          }
        }).catch(() => { /* command errors are reported by the runtime layer */ });
        return;
      }
    }

    setInput("");

    const attachmentsToSend = attachments.length > 0 ? attachments : undefined;
    const attachmentUrls = attachments.map((a) => ({ url: a.dataUrl, name: a.name, kind: a.kind }));

    addMessage(targetThreadId!, "user", content, undefined, undefined, undefined, undefined, attachmentUrls);

    // Resolve context references and append to prompt payload
    const store = useCairnStore.getState();
    const resolvedMessage = await resolvePromptContext(
      content,
      store.notes,
      store.cards,
      store.columns,
      project?.codeDirectory ?? null
    );

    let systemPrompt: string | undefined = undefined;
    if (activeView === "graph") {
      const graphContext = buildGraphContext(graphData, selectedNode);
      const date = new Date().toLocaleDateString("en-US", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      });
      systemPrompt = `## Context\n- **Date:** ${date}\n\n${GRAPH_SYSTEM_PROMPT}\n\n--- CURRENT GRAPH SNAPSHOT ---\n${graphContext}`;
    }

    // Active chat personality (Default = none). The main process appends its
    // prompt to the system prompt as a delimited style layer.
    const activePersonality = aiConfig.installedPersonalities?.find((p) => p.id === aiConfig.personalityId);

    const formatChatHistory = (msgs: typeof messages) => {
      const history: ChatHistoryEntry[] = [];
      msgs.slice(-40).forEach((m) => {
        if (m.role === "user") {
          history.push({
            role: "user",
            content: m.content || "",
          });
        } else if (m.role === "assistant") {
          const toolCalls = m.toolCalls?.filter((tc) => tc.callId && tc.args);
          if (toolCalls && toolCalls.length > 0) {
            history.push({
              role: "assistant",
              content: m.content || null,
              tool_calls: toolCalls.map((tc) => ({
                id: tc.callId!,
                type: "function" as const,
                function: { name: tc.tool, arguments: tc.args! }
              })),
              ...(m.reasoning ? { reasoning: m.reasoning } : {}),
              ...(m.reasoningField ? { reasoningField: m.reasoningField } : {}),
              ...(m.reasoningModel ? { reasoningModel: m.reasoningModel } : {}),
              ...(m.reasoningItems && m.reasoningItems.length > 0 ? { reasoningItems: m.reasoningItems } : {}),
            });
            toolCalls.forEach((tc) => {
              history.push({
                role: "tool",
                tool_call_id: tc.callId!,
                name: tc.tool,
                content: tc.output || "{}"
              });
            });
          } else {
            // Skip assistant turns with no content, no tool calls, and no
            // reasoning items to round-trip — a thinking model that stopped
            // mid-reasoning leaves an empty turn (its reasoning is stripped
            // before re-send), and replaying it trips the provider's "content
            // or tool_calls must be set" 400. A turn carrying reasoning items
            // IS kept so a resumed thread can replay its chain-of-thought
            // (the loop gates the replay on the same model key).
            if (!m.content?.trim() && !(m.reasoningItems && m.reasoningItems.length > 0)) return;
            history.push({
              role: "assistant",
              content: m.content || null,
              ...(m.reasoning ? { reasoning: m.reasoning } : {}),
              ...(m.reasoningField ? { reasoningField: m.reasoningField } : {}),
              ...(m.reasoningModel ? { reasoningModel: m.reasoningModel } : {}),
              ...(m.reasoningItems && m.reasoningItems.length > 0 ? { reasoningItems: m.reasoningItems } : {}),
            });
          }
        } else if (m.role === "system") {
          history.push({
            role: "system",
            content: m.content || "",
          });
        }
      });
      return history;
    };

    // Timeline scrub is view-only (like dsh TrajectoryTimeline timelineFocusIndexes) — it dims
    // rows outside range via visibleMessages for Virtuoso, but history sent to the
    // model is always the full transcript (messages), not the scrubbed slice. The
    // previous bug was historyForLog derived from visibleMessages, so scrubbing to
    // 20% would send only 20% of history as context and the next turn would lose
    // track (the "bonkers" duplicate Hello! after a scrub).
    const historyForLog = formatChatHistory(messages);
    sendStream({
      message: resolvedMessage, threadId: targetThreadId!,
      projectId: activeProjectId,
      workspaceId: activeWorkspaceId,
      history: historyForLog,
      config: {
        provider:    aiConfig.provider    || "openai",
        baseUrl:     aiConfig.baseUrl     || undefined,
        model:       aiConfig.model       || undefined,
        apiKey:      aiConfig.apiKey      || undefined,
        maxSteps:    aiConfig.maxSteps    ?? 30,
        // Auto (unset) or a model that doesn't support temperature → omitted,
        // so the vendor's own sampling default applies (see effectiveTemperatureForModel).
        temperature: effectiveTemperatureForModel(aiConfig.model, aiConfig.temperature),
        // Max output tokens: Auto sends a generous 32K cap (bounded by the
        // model's declared output limit) so the model can finish naturally — a
        // manual value is a deliberate user cost/latency ceiling.
        maxTokens: resolveMaxOutputTokens(
          aiConfig.maxOutputAuto === false ? aiConfig.maxOutputTokens : undefined,
          getModelInfo(aiConfig.model)?.maxOutput,
        ),
        // Reasoning models get the `developer` system role (OpenAI convention).
        isReasoningModel: getModelInfo(aiConfig.model)?.reasoning === true,
        // Only send reasoning effort to reasoning-capable models — otherwise the
        // provider rejects/ignores the field. Chat defaults are set in the store.
        reasoningEffort: getModelInfo(aiConfig.model)?.reasoning === true ? aiConfig.reasoningEffort : undefined,
        contextLimit: aiConfig.contextLimit,
        contextWindow: aiConfig.contextLimit,
      },
      systemPrompt,
      // Active chat personality (Default = none). The main process appends it
      // to the system prompt as a delimited style layer.
      personality: activePersonality ? { name: activePersonality.name, prompt: activePersonality.prompt } : undefined,
      images: attachmentsToSend?.map((a) => ({ name: a.name, dataUrl: a.dataUrl, kind: a.kind })),
      // Subagents is now a GLOBAL AI setting (aiConfig.subagentsEnabled), not a
      // per-thread flag. Ignored server-side / here for the localllm provider.
      useSubagents: aiConfig.provider !== "localllm" && (aiConfig.subagentsEnabled ?? false),
    });
  }, [input, threadId, addMessage, sendStream, activeProjectId, activeWorkspaceId, messages, aiConfig, activeView, graphData, selectedNode, handleArchiveChat, project, enqueue, registryCommands]);

  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);

  // Drain the queue: when a turn finishes (loading went true → false), send the
  // next queued message. Keep the queue on Stop (the user only cancels the
  // in-flight reply) and drain after errors too — any turn ending advances the
  // queue. The sink is refreshed via useLayoutEffect inside the hook, so the
  // drained send always closes over the LATEST history (including the reply
  // that just finished) — never a stale pre-reply snapshot.
  useQueueDrain(isLoading, drainNext, (next) => {
    // Only drain into the thread the message was queued for — a thread switch
    // in the same commit must not post it into the newly active thread.
    if (next.threadId === threadId) {
      handleSend(next.content, next.attachments);
    }
  });

  const handleRetry = useCallback((content: string) => {
    handleSend(content);
  }, [handleSend]);

  const shouldAutoSendRef = useRef(false);

  // Pre-fill input when opened via cairn:open-chat event
  useEffect(() => {
    if (prefill) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInput(prefill.text);
      if (prefill.autoSend) {
        shouldAutoSendRef.current = true;
      }
      onPrefillConsumed?.();
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [prefill, onPrefillConsumed]);

  useEffect(() => {
    if (threadId && shouldAutoSendRef.current) {
      shouldAutoSendRef.current = false;
      const textToSend = input.trim() || prefill?.text;
      if (textToSend) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        handleSend(textToSend);
      }
    }
  }, [threadId, input, prefill, handleSend]);

  // ── Popout mode: close project dropdown on outside click ──
  useEffect(() => {
    if (!popoutMode || !projectOpen) return;
    const handler = (e: MouseEvent) => {
      if (projectRef.current && !projectRef.current.contains(e.target as Node)) {
        setProjectOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [popoutMode, projectOpen]);

  const handlePopIn = useCallback(async () => {
    const state = useCairnStore.getState();
    if (state.activeChatThreadId) {
      await window.electron?.chat.popIn({ sessionId: chatSessionId(state.activeChatThreadId) });
    }
  }, []);

  return (
    <div className="chat-themed flex flex-1 flex-col min-h-0 overflow-hidden">
      {timelineOpen && (
        <div className="px-3 py-2 border-b border-[var(--border)] bg-[var(--surface-2)] flex-shrink-0">
          <ChatTimeline
            spans={timelineSpans}
            range={timelineRange}
            onRangeChange={setTimelineRange}
            onSpanSelect={(idx) => chatVirtuosoRef.current?.scrollToIndex({ index: idx, align: "center", behavior: "smooth" })}
          />
          {timelineRange && <div className="text-[0.607rem] text-[var(--text-tertiary)] mt-1">Showing {visibleMessages.length} of {messages.length} messages — drag or wheel to zoom, double-click to reset</div>}
        </div>
      )}

      {/* ConversationPane owns the shared transcript, questions, composer, and
          session-bound rendering. Chat only supplies its live footer and controls. */}
      <StreamingFooterContext.Provider
        value={{
          isLoading,
          pendingQuestions,
          subagents,
          toolCalls,
          streamingContent,
          streamingThought,
          connectorMap,
          activeView,
          handleSend,
          answerQuestions,
        }}
      >
        <ConversationPane
          className="flex-1 min-h-0"
          sessionId={`chat-${threadId ?? ""}`}
          profile="chat"
          messages={timelineRange ? conversationMessages.slice(Math.floor(timelineRange.start * conversationMessages.length), Math.ceil(timelineRange.end * conversationMessages.length)) : conversationMessages}
          input={input}
          onInputChange={setInput}
          onPrompt={(text, attachments) => handleSend(text, attachments)}
          onAbort={stopStream}
          isLoading={isLoading}
          transcriptRef={chatVirtuosoRef}
          centered={activeView === "chat"}
          title={popoutMode ? (
          <div ref={projectRef} className="relative flex-1">
            <button
              onClick={() => setProjectOpen((v) => !v)}
              className="flex items-center gap-1.5 text-[0.714rem] font-semibold text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors"
            >
              {project?.name ?? "Chat"}
              <ChevronDown size={10} className="text-[var(--text-tertiary)]" />
            </button>
            {projectOpen && (
              <div className="absolute left-0 top-full mt-0.5 w-48 z-50 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl overflow-hidden">
                {projects.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => { if (isLoadingRef.current) return; setActiveProject(p.id); setProjectOpen(false); }}
                    className={`w-full text-left px-3 py-2 text-[0.714rem] transition-colors ${
                      p.id === activeProjectId
                        ? "text-[var(--accent)] bg-[var(--surface-2)]"
                        : "text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <span className="text-[0.714rem] text-[var(--text-tertiary)] flex-1 truncate">
            {activeView === "graph" ? "Graph Assistant" : project?.name ?? workspace?.name ?? "AI Assistant"}
          </span>
        )}
          usage={activeThread?.lastUsage}
          contextLimit={aiConfig.contextLimit ?? 128000}
          actions={(
            <>
              {threadId && <ChatQuickSettings disabled={isLoading} />}
              <Tooltip content={timelineOpen ? "Hide timeline scrubber" : "Show timeline scrubber"} side="left">
                <button onClick={() => setTimelineOpen((v) => !v)} className={cn("p-1 rounded transition-colors", timelineOpen ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)]")} aria-pressed={timelineOpen}><History size={11} /></button>
              </Tooltip>
              {messages.length > 0 && <Tooltip content="Clear conversation" side="left"><button onClick={handleClear} className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--danger)] hover:bg-[var(--surface-3)] transition-colors"><Trash2 size={11} /></button></Tooltip>}
              {popoutMode && <Tooltip content="Return chat to main window" side="left"><button onClick={handlePopIn} className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors"><ArrowLeftFromLine size={11} /></button></Tooltip>}
            </>
          )}
          connectors={connectorMap}
          onRetry={!isLoading ? handleRetry : undefined}
          projection={{ pendingQuestions }}
          onAnswerQuestions={(answers) => { if (!answerQuestions(answers)) void handleSend(answers); }}
          emptyState={<ConversationEmptyState content={<SuggestedPrompts onSend={handleSend} disabled={isLoading || !threadId} prompts={activeView === "graph" ? graphPrompts : undefined} subTitle={activeView === "graph" ? "Ask me to analyze your graph, suggest missing links, wikilinks, or tags." : undefined} />} />}
          transcriptFooter={ChatFooter}
          composerBefore={(
            <div className={cn("flex-shrink-0 border-t border-[var(--border)] bg-[var(--surface)]", activeView === "chat" && "max-w-3xl mx-auto w-full")}>
              {isLoading && <ConversationWorkingStatus label="Cairn is working — you can queue messages below" />}
              <ConversationQueueDock items={queued as ConversationQueuedItem[]} expanded={queueExpanded} onToggle={() => setQueueExpanded((v) => !v)} onRemove={removeQueued} noun="message" />
              <ChatFooterSlot threadId={threadId ?? null} usage={activeThread?.lastUsage ? { ...activeThread.lastUsage, contextLimit: activeThread.lastUsage.contextLimit ?? (aiConfig.contextAuto === false ? aiConfig.contextLimit : undefined) ?? getModelInfo(aiConfig.model)?.context ?? aiConfig.contextLimit ?? 128000, contextWindow: activeThread.lastUsage.contextWindow ?? (aiConfig.contextAuto === false ? aiConfig.contextLimit : undefined) ?? getModelInfo(aiConfig.model)?.context ?? aiConfig.contextLimit ?? 128000 } : undefined} />
            </div>
          )}
          composerRef={inputRef}
          placeholder={activeView === "graph" ? "Ask about your knowledge graph…" : "Ask about your project…"}
          composerProps={{ centered: activeView === "chat", commands: chatCommands, suggestions: mentionSuggestions, allowImages, allowPdf, providerModelTarget: "ai", variant: activeView === "chat" ? "overview" : "default", showSparkles: activeView === "chat", statusText: isLoading ? "Working… click ◼ to stop" : "Shift+Enter for new line · Enter to send", queueWhileBusy: isLoading, queuedCount: queued.length, footerTrailing: aiConfig.provider === "localllm" ? <span className="text-[0.625rem] font-bold text-[var(--accent-fg)] bg-gradient-to-r from-[var(--accent)] to-[color-mix(in_srgb,var(--accent)_60%,var(--background))] px-1.5 py-0.5 rounded shadow-sm flex items-center gap-0.5 select-none whitespace-nowrap shrink-0" title="On-Device private inference powered by Llama">{chatPanelWidth < 360 ? "Local" : "On-Device Llama"}</span> : undefined }}
        />
      </StreamingFooterContext.Provider>

    </div>
  );
}
