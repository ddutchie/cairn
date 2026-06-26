"use client";

import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { Trash2, ChevronDown, ArrowLeftFromLine } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { useChatStream } from "@/hooks/useChatStream";
import { buildGraphContext } from "@/components/graph/graph-ai-utils";
import { ipcAwaitResult } from "@/store/ipc";
import { resolvePromptContext } from "@/lib/context-resolver";

import { Tooltip } from "@/components/ui/tooltip";
import { ChatMessageBubble } from "./ChatMessageBubble";
import { SuggestedPrompts } from "./SuggestedPrompts";
import { ToolCallIndicator } from "./ToolCallIndicator";
import { QuestionForm } from "./QuestionForm";
import { ChatInput, SuggestionItem } from "../ChatInput";
import { ContextRing } from "@/components/agent/ContextRing";

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

const CHAT_SLASH_COMMANDS = [
  {
    name: "archive-chat",
    description: "Archive conversation as a note & clear chat",
    insertText: "/archive-chat",
  },
  {
    name: "compact",
    description: "Summarise and compact conversation history",
    insertText: "/compact",
  },
  {
    name: "board",
    description: "Show all task board columns and cards",
    insertText: "List the current task board columns and cards.",
  },
  {
    name: "review-note",
    description: "Ask AI to review a note",
    insertText: 'Please review my note "[note title]" and suggest improvements.',
  },
];

interface ChatPanelProps {
  prefill?: { text: string; autoSend?: boolean } | null;
  onPrefillConsumed?: () => void;
  popoutMode?: boolean;
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
  })));

  // threadId is driven by the store so the tab bar can switch threads externally
  const threadId = activeChatThreadId;

  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<Array<{ name: string; dataUrl: string }>>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef       = useRef<HTMLTextAreaElement>(null);
  const projectRef     = useRef<HTMLDivElement>(null);
  const [projectOpen, setProjectOpen] = useState(false);

  const { isLoading, toolCalls, streamingContent, streamingThought, pendingQuestions, sendStream, stopStream } = useChatStream(threadId);

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
    if (isLoading) stopStream();
    clearThreadMessages(threadId);
  }, [threadId, isLoading, stopStream, clearThreadMessages]);

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

  useEffect(() => { if (isChatActive) messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, isLoading, isChatActive]);
  useEffect(() => { if (chatOpen) inputRef.current?.focus(); }, [chatOpen]);

  const handleAttachImages = useCallback(async (files: File[]) => {
    const imageItems: Array<{ name: string; dataUrl: string }> = [];
    for (const file of files) {
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
          reader.onabort = () => reject(new Error(`Read aborted for ${file.name}`));
          reader.readAsDataURL(file);
        });
        imageItems.push({ name: file.name, dataUrl });
      } catch (err) {
        console.error("[chat] Skipping unreadable image:", err);
      }
    }
    setPendingImages((prev) => [...prev, ...imageItems]);
  }, []);

  const handleRemoveImage = useCallback((index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSend = useCallback(async (text?: string) => {
    const content = text ?? input.trim();
    if ((!content || !content.trim()) && pendingImages.length === 0) return;
    if (!threadId) return;

    const trimmed = content.trim();
    if (!pendingImages.length) {
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

    const imagesToSend = pendingImages.length > 0 ? pendingImages : undefined;
    const imageUrls = pendingImages.map((img) => ({ url: img.dataUrl, name: img.name }));
    setPendingImages([]);

    addMessage(threadId, "user", content, undefined, undefined, undefined, undefined, imageUrls);

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

    const formatChatHistory = (msgs: typeof messages) => {
      const history: Array<{
        role: string;
        content: string | null;
        tool_calls?: Array<{
          id: string;
          type: "function";
          function: { name: string; arguments: string };
        }>;
        tool_call_id?: string;
        name?: string;
      }> = [];
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
              }))
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
            history.push({
              role: "assistant",
              content: m.content || null,
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
        temperature: aiConfig.temperature ?? 0.3,
      },
      systemPrompt,
      images: imagesToSend?.map((img) => ({ name: img.name, dataUrl: img.dataUrl })),
    });
  }, [input, threadId, addMessage, sendStream, activeProjectId, activeWorkspaceId, messages, aiConfig, activeView, graphData, selectedNode, handleArchiveChat, project, pendingImages]);

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
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden bg-[var(--surface)]">
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
          />
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

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0">
        {messages.length === 0
          ? (
              <SuggestedPrompts
                onSend={handleSend}
                disabled={isLoading || !threadId}
                prompts={activeView === "graph" ? graphPrompts : undefined}
                subTitle={activeView === "graph" ? "Ask me to analyze your graph, suggest missing links, wikilinks, or tags." : undefined}
              />
            )
          : messages.map((message) => (
              <ChatMessageBubble
                key={message.id}
                message={message}
                onRetry={!isLoading ? handleRetry : undefined}
              />
            ))
        }
        {pendingQuestions && (
          <QuestionForm
            questions={pendingQuestions}
            onSubmit={(text) => handleSend(text)}
            disabled={isLoading && !pendingQuestions}
          />
        )}
        {isLoading && <ToolCallIndicator toolCalls={toolCalls} streamingContent={streamingContent} streamingThought={streamingThought} />}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-[var(--border)] p-3 flex-shrink-0">
        <ChatInput
          ref={inputRef}
          value={input}
          onChange={setInput}
          onSubmit={() => handleSend()}
          onStop={stopStream}
          isLoading={isLoading}
          disabled={isLoading}
          placeholder={activeView === "graph" ? "Ask about your knowledge graph…" : "Ask about your project…"}
          commands={CHAT_SLASH_COMMANDS}
          suggestions={mentionSuggestions}
          pendingImages={pendingImages}
          onRemoveImage={handleRemoveImage}
          onAttachImages={handleAttachImages}
        />
        <div className="flex items-center justify-between mt-1.5 px-0.5">
          <p className="text-[0.714rem] text-[var(--text-tertiary)]">
            {isLoading ? "Generating… click ◼ to stop" : "Shift+Enter for new line · Enter to send"}
          </p>
          {aiConfig.provider === "localllm" && (
            <span className="text-[0.625rem] font-bold text-white bg-gradient-to-r from-purple-500 to-indigo-500 px-1.5 py-0.5 rounded shadow-sm flex items-center gap-0.5 select-none whitespace-nowrap shrink-0" title="On-Device private inference powered by Llama">
              {chatPanelWidth < 360 ? "Local" : "On-Device Llama"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
