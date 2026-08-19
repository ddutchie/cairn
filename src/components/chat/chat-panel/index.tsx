"use client";

import React, { useState, useRef, useEffect, useMemo, useCallback, useSyncExternalStore } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { Trash2, ChevronDown, ArrowLeftFromLine, Loader2, Clock } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { useChatStream } from "@/hooks/useChatStream";
import type { ChatToolCall, PendingQuestion } from "@/hooks/useChatStream";
import { useChatMessageQueue, useQueueDrain, type QueuedMessage } from "@/hooks/useChatMessageQueue";
import { buildGraphContext } from "@/components/graph/graph-ai-utils";
import { ipcAwaitResult } from "@/store/ipc";
import { resolvePromptContext } from "@/lib/context-resolver";

import type { ChatHistoryEntry, ChatSubagent } from "@/types";

import { Tooltip } from "@/components/ui/tooltip";
import { ChatInputArea } from "../ChatInputArea";
import type { SuggestionItem } from "../ChatInput";
import { ChatMessageBubble } from "./ChatMessageBubble";
import { ChatSubagentBlock } from "./ChatSubagentBlock";
import { ChatQuickSettings } from "./ChatQuickSettings";
import { SuggestedPrompts } from "./SuggestedPrompts";
import { ToolCallIndicator } from "./ToolCallIndicator";
import { useCommunityConnectorMap, type ChatConnectorMeta } from "./connector-context";
import { QuestionForm } from "./QuestionForm";
import { ContextRing } from "@/components/agent/ContextRing";
import { getCommandsForScope } from "@/lib/slash-commands";
import { cn, id } from "@/lib/utils";
import {
  getModelInfo,
  getModelCatalogVersion,
  prewarmModelCatalog,
  subscribeModelCatalog,
  effectiveTemperatureForModel,
} from "@/lib/models-dev";
import { supportsImageInput, resolveMaxOutputTokens } from "../../../../shared/models/model-catalog";
import { supportsPdfInput } from "../../../../shared/models/pdf-attach";

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
            <ChatSubagentBlock key={sub.childId} sub={sub} />
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
      {s.pendingQuestions && handleSend && (
        <QuestionForm
          questions={s.pendingQuestions}
          onSubmit={(text) => handleSend(text)}
          onSubmitStructured={s.answerQuestions}
          disabled={s.isLoading}
        />
      )}
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
  // Messages the user queued while a turn was running — sent (FIFO) when the
  // current reply finishes. Each item carries the thread + attachments captured
  // at enqueue time so a thread switch or queued images/PDFs are never lost.
  // Session-scoped; cleared on thread switch.
  const { queued, queueExpanded, setQueueExpanded, enqueue, removeQueued, clearQueue, drainNext } = useChatMessageQueue<QueuedMessage>();
  const chatCommands = useMemo(
    () => getCommandsForScope("chat", customCommands),
    [customCommands]
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

  const handleClear = useCallback(() => {
    if (!threadId) return;
    // Drop queued messages FIRST: stopping the stream flips isLoading to false,
    // which fires the queue-drain — a pending prompt must not be sent into a
    // just-cleared thread.
    clearQueue();
    if (isLoading) stopStream();
    // Drop any in-flight questions form too — it belongs to this thread and
    // would otherwise linger after the transcript is cleared.
    clearQuestions();
    clearThreadMessages(threadId);
  }, [threadId, isLoading, stopStream, clearThreadMessages, clearQuestions, clearQueue]);

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

    // Workspace changed — invalidate the active thread regardless of project match
    if (prevWorkspace !== activeWorkspaceId) {
      // Fall through to getOrCreateThread below
    } else if (prevProject === activeProjectId) {
      // Neither changed — only initialise if no thread is active yet
      if (activeChatThreadId) return;
    } else {
      // Project changed — check if the current thread still matches
      if (activeChatThreadId) {
        const currentThread = useCairnStore.getState().chatThreads.find(
          (t) => t.id === activeChatThreadId,
        );
        // Keep the thread if it matches the new project or is workspace-scoped
        if (currentThread && currentThread.projectId === activeProjectId) return;
      }
    }

    const t = useCairnStore.getState().getOrCreateThread(activeWorkspaceId, activeProjectId ?? undefined);
    setActiveChatThreadId(t.id);
  }, [activeWorkspaceId, activeProjectId, activeChatThreadId, setActiveChatThreadId]);

  // Also initialise on first mount when activeChatThreadId is already null
  useEffect(() => {
    if (!activeWorkspaceId || activeChatThreadId) return;
    const t = useCairnStore.getState().getOrCreateThread(activeWorkspaceId, activeProjectId ?? undefined);
    setActiveChatThreadId(t.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const messages = useMemo(
    () => threadId ? chatMessages.filter((m) => m.threadId === threadId) : [],
    [threadId, chatMessages],
  );

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
    if (!threadId) return;

    // A turn is already running — queue this message instead of interrupting it.
    // The queue drains (FIFO) when the current reply finishes. Attachments are
    // queued alongside the text so staged images/PDFs are never silently dropped.
    if (isLoadingRef.current) {
      if (!content.trim() && attachments.length === 0) return;
      enqueue({ id: id(), content, threadId, attachments });
      setInput("");
      return;
    }

    const trimmed = content.trim();
    if (!attachments.length) {
      if (trimmed === "/compact" || trimmed === "/ compact") {
        setInput("");
        useCairnStore.getState().compactChatThread(threadId);
        return;
      }

      if (trimmed === "/archive-chat" || trimmed === "/archive" || trimmed === "/ archive-chat" || trimmed === "/ archive") {
        setInput("");
        handleArchiveChat();
        return;
      }
    }

    setInput("");

    const attachmentsToSend = attachments.length > 0 ? attachments : undefined;
    const attachmentUrls = attachments.map((a) => ({ url: a.dataUrl, name: a.name, kind: a.kind }));

    addMessage(threadId, "user", content, undefined, undefined, undefined, undefined, attachmentUrls);

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

    sendStream({
      message: resolvedMessage, threadId,
      projectId: activeProjectId,
      workspaceId: activeWorkspaceId,
      history: formatChatHistory(messages),
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
  }, [input, threadId, addMessage, sendStream, activeProjectId, activeWorkspaceId, messages, aiConfig, activeView, graphData, selectedNode, handleArchiveChat, project, enqueue]);

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
    await window.electron?.chat.popIn({
      threadId: state.activeChatThreadId as string | null,
      chatThreads: state.chatThreads as unknown[],
      chatMessages: state.chatMessages as unknown[],
      activeProjectId: state.activeProjectId as string | null,
    });
  }, []);

  return (
    <div className="chat-themed flex flex-1 flex-col min-h-0 overflow-hidden">
      {/* Sub-header / toolbar */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-[var(--border)] bg-[var(--surface-2)] flex-shrink-0">
        {popoutMode ? (
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

        {activeThread?.lastUsage && (
          <ContextRing
            promptTokens={activeThread.lastUsage.promptTokens}
            contextLimit={aiConfig.contextLimit ?? 128000}
            breakdown={activeThread.lastUsage.breakdown}
            completionTokens={activeThread.lastUsage.completionTokens}
            reasoningTokens={activeThread.lastUsage.reasoningTokens}
            cacheReadTokens={activeThread.lastUsage.cacheReadTokens}
            cacheCreationTokens={activeThread.lastUsage.cacheCreationTokens}
            costUsd={activeThread.lastUsage.costUsd}
          />
        )}

        {threadId && (
          <ChatQuickSettings disabled={isLoading} />
        )}


        {messages.length > 0 && (
          <Tooltip content="Clear conversation" side="left">
            <button onClick={handleClear}
              className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--danger)] hover:bg-[var(--surface-3)] transition-colors">
              <Trash2 size={11} />
            </button>
          </Tooltip>
        )}

        {popoutMode && (
          <Tooltip content="Return chat to main window" side="left">
            <button onClick={handlePopIn}
              className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors">
              <ArrowLeftFromLine size={11} />
            </button>
          </Tooltip>
        )}
      </div>

      {/* Messages — virtualized so long threads never balloon the DOM; only the
          items near the viewport are mounted no matter how far you scroll. The
          StreamingFooterContext feeds the stable Footer (see ChatFooter) so the
          streaming indicator stays inside the scroller, growing downward. */}
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
        <Virtuoso
          ref={chatVirtuosoRef}
          className="flex-1 min-h-0"
          data={messages}
          initialTopMostItemIndex={Math.max(0, messages.length - 1)}
          followOutput={(isAtBottom) => (isAtBottom ? "smooth" : false)}
          components={{
            EmptyPlaceholder: () => (
              <div className={cn("px-3 py-3", activeView === "chat" && "max-w-3xl mx-auto w-full px-4")}>
                <SuggestedPrompts
                  onSend={handleSend}
                  disabled={isLoading || !threadId}
                  prompts={activeView === "graph" ? graphPrompts : undefined}
                  subTitle={activeView === "graph" ? "Ask me to analyze your graph, suggest missing links, wikilinks, or tags." : undefined}
                />
              </div>
            ),
            Footer: ChatFooter,
          }}
          itemContent={(_index, message) => (
            <div className={cn("px-3 py-1.5", activeView === "chat" && "max-w-3xl mx-auto w-full px-4")}>
              <ChatMessageBubble
                message={message}
                onRetry={!isLoading ? handleRetry : undefined}
                connectors={connectorMap}
              />
            </div>
          )}
        />
      </StreamingFooterContext.Provider>

      {/* Input */}
      {(isLoading || queued.length > 0) && (
        <div className={cn("border-t border-[var(--border)] bg-[var(--surface)]", activeView === "chat" && "max-w-3xl mx-auto w-full")}>
          {isLoading && (
            <div className="flex items-center gap-1.5 px-3 py-1.5">
              <Loader2 size={11} className="text-[var(--accent)] animate-spin shrink-0" />
              <span className="text-[0.714rem] text-[var(--text-secondary)]">Cairn is working — you can queue messages below</span>
            </div>
          )}
          {queued.length > 0 && (
            <div className={isLoading ? "border-t border-[var(--border)]" : undefined}>
              <button
                type="button"
                onClick={() => setQueueExpanded((v) => !v)}
                className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-[var(--surface-2)] transition-colors"
              >
                <Clock size={11} className="text-[var(--text-tertiary)] shrink-0" />
                <span className="text-[0.714rem] text-[var(--text-secondary)]">
                  {queued.length} message{queued.length === 1 ? "" : "s"} queued — will send after the current reply
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
        </div>
      )}
      <div className={cn("border-t border-[var(--border)] p-3 flex-shrink-0", activeView === "chat" && "border-t-0 bg-transparent p-6 max-w-3xl mx-auto w-full")}>
        <ChatInputArea
          ref={inputRef}
          value={input}
          onChange={setInput}
          onSubmit={(text, attachments) => handleSend(text, attachments)}
          onStop={stopStream}
          isLoading={isLoading}
          placeholder={activeView === "graph" ? "Ask about your knowledge graph…" : "Ask about your project…"}
          commands={chatCommands}
          suggestions={mentionSuggestions}
          allowImages={allowImages}
          allowPdf={allowPdf}
          providerModelTarget="ai"
          variant={activeView === "chat" ? "overview" : "default"}
          showSparkles={activeView === "chat"}
          statusText={isLoading ? "Working… click ◼ to stop" : "Shift+Enter for new line · Enter to send"}
          queueWhileBusy={isLoading}
          queuedCount={queued.length}
          footerTrailing={aiConfig.provider === "localllm" ? (
            <span className="text-[0.625rem] font-bold text-[var(--accent-fg)] bg-gradient-to-r from-[var(--accent)] to-[color-mix(in_srgb,var(--accent)_60%,var(--background))] px-1.5 py-0.5 rounded shadow-sm flex items-center gap-0.5 select-none whitespace-nowrap shrink-0" title="On-Device private inference powered by Llama">
              {chatPanelWidth < 360 ? "Local" : "On-Device Llama"}
            </span>
          ) : undefined}
        />
      </div>
    </div>
  );
}
