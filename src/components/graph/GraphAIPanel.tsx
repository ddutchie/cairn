"use client";

/**
 * GraphAIPanel — AI assistant embedded in KnowledgeGraphView.
 *
 * The AI writes prose markdown freely, then calls the `suggest_connections`
 * tool to emit structured actions. We intercept that tool call via onToolCall,
 * capture the args, and render each action as an interactive Apply card.
 * Prose and actions are fully separate — no parsing or stripping required.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { X, Send, Square, Sparkles, Loader2, CheckCircle, Link2, FileText, Kanban, Tag, Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { KnowledgeGraph, GraphNode } from "@/types";
import { wikilinkAlreadyExists, buildGraphContext } from "./graph-ai-utils";
import { MarkdownContent } from "@/components/chat/chat-panel/MarkdownContent";

// ── Action types (mirror suggest_connections schema) ──────────────────────────

type SuggestedAction =
  | { type: "add_wikilink";   sourceNoteId: string; sourceTitle: string; targetTitle: string; reason: string }
  | { type: "link_note_note"; sourceNoteId: string; sourceTitle: string; targetNoteId: string; targetTitle: string; reason: string }
  | { type: "link_note_card"; noteId: string; noteTitle: string; cardId: string; cardTitle: string; reason: string }
  | { type: "add_tag";        nodeId: string; nodeTitle: string; nodeType: "note" | "card"; tagName: string; reason: string };

interface Message {
  role: "user" | "assistant";
  content: string;
  actions?: SuggestedAction[];
}

interface GraphAIPanelProps {
  graph: KnowledgeGraph;
  selectedNode: GraphNode | null;
  onClose: () => void;
}



// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Knowledge Graph assistant embedded in Cairn, a note-taking and project management app.

You help users build meaningful connections between their notes, tasks, and projects. You have access to a snapshot of their current knowledge graph — each node includes its ID and title.

Your capabilities:
1. **Suggest missing connections** — identify notes/cards that are related but not yet linked
2. **Recommend wikilinks** — suggest [[Note Title]] wikilinks to add to specific notes
3. **Suggest tags** — recommend tags to apply to notes or cards
4. **Explain connections** — describe why two nodes are related
5. **Graph analysis** — identify clusters, orphan nodes, and structural patterns

## Workflow

Write your analysis as clear, concise markdown prose.

When you have specific actionable suggestions, call the \`suggest_connections\` tool with those actions. The user will see Apply buttons for each one. Use node IDs exactly as they appear in the graph snapshot. Limit to 8 actions maximum.

**Important:** The graph snapshot includes an "EXISTING WIKILINKS" section. Never suggest \`add_wikilink\` actions for pairs that already appear there — those links already exist.

Do not put the actions in your prose — call the tool instead.`;

// ── Action card ───────────────────────────────────────────────────────────────

function actionIcon(type: SuggestedAction["type"]) {
  switch (type) {
    case "add_wikilink":   return <Link2 size={11} className="text-[var(--accent)] shrink-0" />;
    case "link_note_note": return <FileText size={11} className="text-[var(--info)] shrink-0" />;
    case "link_note_card": return <Kanban size={11} className="text-[var(--success)] shrink-0" />;
    case "add_tag":        return <Tag size={11} className="text-[var(--warning)] shrink-0" />;
  }
}

function actionLabel(action: SuggestedAction): string {
  switch (action.type) {
    case "add_wikilink":   return `Add [[${action.targetTitle}]] → "${action.sourceTitle}"`;
    case "link_note_note": return `Link "${action.sourceTitle}" ↔ "${action.targetTitle}"`;
    case "link_note_card": return `Link "${action.noteTitle}" → "${action.cardTitle}"`;
    case "add_tag":        return `Tag "${action.nodeTitle}" #${action.tagName}`;
  }
}

interface ActionCardProps {
  action: SuggestedAction;
  state: "idle" | "applying" | "done";
  onApply: () => Promise<void>;
  onDismiss: () => void;
}

function ActionCard({ action, state, onApply, onDismiss }: ActionCardProps) {
  const [expanded, setExpanded] = useState(false);

  async function handleApply() {
    await onApply();
  }

  return (
    <div className={cn(
      "rounded-lg border text-[0.714rem] overflow-hidden transition-colors",
      state === "done"
        ? "border-[var(--success)]/30 bg-[color-mix(in_srgb,var(--success)_6%,transparent)]"
        : "border-[var(--border)] bg-[var(--surface)]"
    )}>
      <div className="flex items-center gap-2 px-2.5 py-2">
        {actionIcon(action.type)}
        <span className={cn(
          "flex-1 min-w-0 leading-snug",
          state === "done" ? "text-[var(--text-tertiary)] line-through truncate" : "text-[var(--text-secondary)]"
        )}>
          {actionLabel(action)}
        </span>

        <button
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
          title="Why?"
        >
          {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        </button>

        {state === "done" ? (
          <Check size={11} className="text-[var(--success)] shrink-0" />
        ) : (
          <button
            onClick={handleApply}
            disabled={state === "applying"}
            className="shrink-0 px-2 py-0.5 rounded bg-[var(--accent-dim)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] transition-colors disabled:opacity-50 text-[0.643rem] font-medium"
          >
            {state === "applying" ? <Loader2 size={9} className="animate-spin" /> : "Apply"}
          </button>
        )}

        {state !== "done" && (
          <button
            onClick={onDismiss}
            className="shrink-0 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            title="Dismiss"
          >
            <X size={10} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="px-2.5 pb-2 pt-1.5 text-[0.643rem] text-[var(--text-tertiary)] leading-relaxed border-t border-[var(--border)]">
          {action.reason}
        </div>
      )}
    </div>
  );
}

// ── Actions list ──────────────────────────────────────────────────────────────

interface ActionsListProps {
  actions: SuggestedAction[];
  notes: { id: string; title: string; content?: string | null; linkedNoteIds: string[]; linkedCardIds: string[]; tagIds: string[] }[];
  cards: { id: string; linkedNoteIds: string[]; tagIds: string[] }[];
  tags: { id: string; name: string; workspaceId: string }[];
  activeWorkspaceId: string | null;
  updateNote: (id: string, patch: object) => void;
  updateCard: (id: string, patch: object) => void;
  linkNoteToCard: (noteId: string, cardId: string) => void;
  createTag: (workspaceId: string, name: string) => { id: string };
  recomputeGraphRelationships: (workspaceId: string) => Promise<void>;
  recomputeGraphRelationshipsIncremental: (workspaceId: string, entityIds: string[]) => Promise<void>;
}

function ActionsList(props: ActionsListProps) {
  const { actions, notes, cards, tags, activeWorkspaceId, updateNote, updateCard, linkNoteToCard, createTag, recomputeGraphRelationshipsIncremental } = props;
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [cardStates, setCardStates] = useState<Map<number, "idle" | "applying" | "done">>(() => new Map());
  const [applyAllState, setApplyAllState] = useState<"idle" | "applying" | "done">("idle");

  function setCardState(i: number, state: "idle" | "applying" | "done") {
    setCardStates((prev) => new Map(prev).set(i, state));
  }

  async function applyAction(action: SuggestedAction) {
    const affectedIds: string[] = [];
    switch (action.type) {
      case "add_wikilink": {
        const note = notes.find((n) => n.id === action.sourceNoteId);
        if (!note) throw new Error("Note not found");
        const existing = note.content ?? "";
        if (wikilinkAlreadyExists(existing, action.targetTitle)) break;
        updateNote(action.sourceNoteId, { content: existing + `\n\n[[${action.targetTitle}]]` });
        affectedIds.push(action.sourceNoteId);
        break;
      }
      case "link_note_note": {
        const src = notes.find((n) => n.id === action.sourceNoteId);
        const tgt = notes.find((n) => n.id === action.targetNoteId);
        if (!src || !tgt) throw new Error("Note not found");
        updateNote(action.sourceNoteId, { linkedNoteIds: Array.from(new Set([...src.linkedNoteIds, action.targetNoteId])) });
        updateNote(action.targetNoteId, { linkedNoteIds: Array.from(new Set([...tgt.linkedNoteIds, action.sourceNoteId])) });
        affectedIds.push(action.sourceNoteId, action.targetNoteId);
        break;
      }
      case "link_note_card": {
        linkNoteToCard(action.noteId, action.cardId);
        affectedIds.push(action.noteId, action.cardId);
        break;
      }
      case "add_tag": {
        if (!activeWorkspaceId) throw new Error("No workspace");
        const existingTag = tags.find((t) => t.name.toLowerCase() === action.tagName.toLowerCase());
        const tag = existingTag ?? createTag(activeWorkspaceId, action.tagName);
        if (action.nodeType === "note") {
          const note = notes.find((n) => n.id === action.nodeId);
          if (note) updateNote(action.nodeId, { tagIds: Array.from(new Set([...note.tagIds, tag.id])) });
        } else {
          const card = cards.find((c) => c.id === action.nodeId);
          if (card) updateCard(action.nodeId, { tagIds: Array.from(new Set([...card.tagIds, tag.id])) });
        }
        affectedIds.push(action.nodeId);
        break;
      }
    }
    if (activeWorkspaceId && affectedIds.length > 0) {
      recomputeGraphRelationshipsIncremental(activeWorkspaceId, affectedIds).catch(() => {});
    }
  }

  async function handleApplyAll() {
    setApplyAllState("applying");
    for (let i = 0; i < actions.length; i++) {
      if (dismissed.has(i)) continue;
      setCardState(i, "applying");
      try {
        await applyAction(actions[i]);
        setCardState(i, "done");
      } catch {
        setCardState(i, "idle");
      }
    }
    setApplyAllState("done");
  }

  const visible = actions.filter((_, i) => !dismissed.has(i));
  if (visible.length === 0) return null;

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[0.643rem] font-medium text-[var(--text-tertiary)] uppercase tracking-wide">
          {visible.length} suggested action{visible.length !== 1 ? "s" : ""}
        </span>
        {visible.length > 1 && applyAllState === "idle" && (
          <button onClick={handleApplyAll} className="text-[0.643rem] text-[var(--accent)] hover:underline">
            Apply all
          </button>
        )}
        {applyAllState === "done" && (
          <span className="text-[0.643rem] text-[var(--success)] flex items-center gap-1">
            <Check size={9} /> All applied
          </span>
        )}
      </div>
      {actions.map((action, i) =>
        dismissed.has(i) ? null : (
          <ActionCard
            key={i}
            action={action}
            state={cardStates.get(i) ?? "idle"}
            onApply={async () => {
              setCardState(i, "applying");
              try {
                await applyAction(action);
                setCardState(i, "done");
              } catch {
                setCardState(i, "idle");
              }
            }}
            onDismiss={() => setDismissed((prev) => new Set([...prev, i]))}
          />
        )
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function GraphAIPanel({ graph, selectedNode, onClose }: GraphAIPanelProps) {
  const {
    aiConfig, notes, cards, tags, activeWorkspaceId,
    updateNote, updateCard, linkNoteToCard, createTag, recomputeGraphRelationships, recomputeGraphRelationshipsIncremental,
  } = useCairnStore(useShallow((s) => ({
    aiConfig:                    s.aiConfig,
    notes:                       s.notes,
    cards:                       s.cards,
    tags:                        s.tags,
    activeWorkspaceId:           s.activeWorkspaceId,
    updateNote:                               s.updateNote,
    updateCard:                               s.updateCard,
    linkNoteToCard:                           s.linkNoteToCard,
    createTag:                               s.createTag,
    recomputeGraphRelationships:              s.recomputeGraphRelationships,
    recomputeGraphRelationshipsIncremental:   s.recomputeGraphRelationshipsIncremental,
  })));

  const [messages, setMessages]          = useState<Message[]>([]);
  const [input, setInput]                = useState("");
  const [isLoading, setIsLoading]        = useState(false);
  const [streamingContent, setStreaming] = useState("");
  const [toolCalls, setToolCalls]        = useState<{ tool: string; label: string }[]>([]);
  // Actions captured from the suggest_connections tool call mid-stream
  const pendingActionsRef = useRef<SuggestedAction[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef       = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent, toolCalls]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const graphContext = useMemo(
    () => buildGraphContext(graph, selectedNode),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      graph.nodes.map((n) => n.id).join(","),
      graph.edges.map((e) => `${e.source}>${e.target}`).join(","),
      selectedNode?.id,
    ]
  );

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;
    const electron = window.electron;
    if (!electron) return;

    const userMsg: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);
    setStreaming("");
    setToolCalls([]);
    pendingActionsRef.current = [];

    const history = [...messages, userMsg].map((m) => ({ role: m.role, content: m.content }));
    const systemPromptWithContext = `${SYSTEM_PROMPT}\n\n--- CURRENT GRAPH SNAPSHOT ---\n${graphContext}`;

    const unsubTool = electron.chat.onToolCall((e: { tool: string; label: string; args: Record<string, unknown> }) => {
      if (e.tool === "suggest_connections") {
        // Capture actions — will be attached to the message on done
        const incoming = (e.args.actions ?? []) as SuggestedAction[];
        pendingActionsRef.current = incoming;
      } else {
        // Show all other tool calls as progress chips
        setToolCalls((prev) => [...prev, { tool: e.tool, label: e.label }]);
      }
    });

    const unsubToken = electron.chat.onToken((e: { delta: string }) => {
      setStreaming((prev) => prev + e.delta);
    });

    const unsubDone = electron.chat.onDone((e: { content: string }) => {
      unsubTool();
      unsubToken();
      unsubDone();
      // Capture actions synchronously before clearing the ref — the setMessages
      // updater function runs asynchronously, so pendingActionsRef.current would
      // already be [] by the time React calls the updater if we don't snapshot it.
      const capturedActions = pendingActionsRef.current;
      pendingActionsRef.current = [];
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: e.content, actions: capturedActions },
      ]);
      setStreaming("");
      setToolCalls([]);
      setIsLoading(false);
    });

    electron.chat.stream({
      message: text,
      threadId: "graph-ai-panel",
      config: { baseUrl: aiConfig.baseUrl, model: aiConfig.model, apiKey: aiConfig.apiKey },
      ...(history.length > 1 ? { history: history.slice(0, -1) } : {}),
      systemPrompt: systemPromptWithContext,
    });
  }, [input, isLoading, messages, graphContext, aiConfig]);

  const stopStream = useCallback(() => {
    window.electron?.chat.abort();
    setIsLoading(false);
    setToolCalls([]);
    if (streamingContent) {
      const capturedActions = pendingActionsRef.current;
      pendingActionsRef.current = [];
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: streamingContent, actions: capturedActions },
      ]);
      setStreaming("");
    }
  }, [streamingContent]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }, [sendMessage]);

  const suggestedPrompts = useMemo(() => {
    const base = [
      "What connections am I missing in this graph?",
      "Which notes are related but not linked?",
      "Suggest wikilinks I should add",
    ];
    if (selectedNode) return [
      `What should I link to "${selectedNode.title}"?`,
      `Explain the connections around "${selectedNode.title}"`,
      ...base.slice(0, 1),
    ];
    return base;
  }, [selectedNode]);

  return (
    <div className="flex flex-col w-80 border-l border-[var(--border)] bg-[var(--surface)] flex-shrink-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)] flex-shrink-0">
        <Sparkles size={13} className="text-[var(--accent)]" />
        <span className="flex-1 text-xs font-medium text-[var(--text-primary)]">Graph Assistant</span>
        {selectedNode && (
          <span className="text-[0.714rem] text-[var(--text-tertiary)] truncate max-w-24" title={selectedNode.title}>
            {selectedNode.title}
          </span>
        )}
        <button onClick={onClose} className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors">
          <X size={13} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-3">

        {/* Empty state */}
        {messages.length === 0 && !isLoading && (
          <div className="space-y-2">
            <p className="text-[0.714rem] text-[var(--text-tertiary)] leading-relaxed">
              Ask me to analyse your graph, suggest connections, or recommend wikilinks.
            </p>
            <div className="space-y-1.5">
              {suggestedPrompts.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => { setInput(prompt); inputRef.current?.focus(); }}
                  className="w-full text-left text-[0.714rem] px-2.5 py-2 rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)] hover:bg-[var(--accent-dim)] transition-colors leading-snug"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Message history */}
        {messages.map((msg, i) => (
          <div key={i} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
            {msg.role === "user" ? (
              <div className="max-w-[95%] rounded-lg px-3 py-2 text-xs leading-relaxed bg-[var(--accent)] text-white">
                {msg.content}
              </div>
            ) : (
              <div className="w-full min-w-0">
                <div className="rounded-lg px-3 py-2 text-xs leading-relaxed bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)]">
                  <MarkdownContent content={msg.content} />
                </div>
                {msg.actions && msg.actions.length > 0 && (
                  <ActionsList
                    actions={msg.actions}
                    notes={notes}
                    cards={cards}
                    tags={tags}
                    activeWorkspaceId={activeWorkspaceId}
                    updateNote={updateNote}
                    updateCard={updateCard}
                    linkNoteToCard={linkNoteToCard}
                    createTag={createTag}
                    recomputeGraphRelationships={recomputeGraphRelationships}
                    recomputeGraphRelationshipsIncremental={recomputeGraphRelationshipsIncremental}
                  />
                )}
              </div>
            )}
          </div>
        ))}

        {/* In-flight: tool call chips + streaming bubble */}
        {isLoading && (
          <div className="flex flex-col gap-1">
            {toolCalls.map((tc, i) => (
              <div key={i} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] w-fit text-[0.714rem] text-[var(--text-secondary)]">
                <CheckCircle size={10} className="text-[var(--accent)] shrink-0" />
                {tc.label}
              </div>
            ))}
            {streamingContent ? (
              <div className="rounded-lg px-3 py-2 text-xs bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)] leading-relaxed">
                <MarkdownContent content={streamingContent} />
                <span className="inline-block w-0.5 h-3 bg-[var(--accent)] animate-pulse ml-0.5 align-middle" />
              </div>
            ) : (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] w-fit text-[0.714rem] text-[var(--text-tertiary)]">
                <Loader2 size={10} className="animate-spin text-[var(--accent)] shrink-0" />
                {toolCalls.length === 0 ? "Thinking…" : "Working…"}
              </div>
            )}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="flex-shrink-0 border-t border-[var(--border)] p-2">
        <div className="flex items-end gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 focus-within:border-[var(--accent)] transition-colors">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about connections…"
            rows={1}
            className="flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder-[var(--text-tertiary)] outline-none resize-none leading-relaxed"
            style={{ minHeight: "1.4rem", maxHeight: "5rem" }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 80)}px`;
            }}
          />
          <button
            onClick={isLoading ? stopStream : sendMessage}
            disabled={!isLoading && !input.trim()}
            className={cn(
              "shrink-0 p-1 rounded transition-colors",
              isLoading
                ? "text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]"
                : input.trim()
                  ? "text-[var(--accent)] hover:bg-[var(--accent-dim)]"
                  : "text-[var(--text-tertiary)] opacity-40 cursor-not-allowed"
            )}
          >
            {isLoading ? <Square size={13} /> : <Send size={13} />}
          </button>
        </div>
        <p className="text-[0.643rem] text-[var(--text-tertiary)] mt-1 px-1">
          {graph.nodes.length} nodes · {graph.edges.length} edges in context
        </p>
      </div>
    </div>
  );
}
