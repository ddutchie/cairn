"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { Wand2, Loader2, Send, Wrench, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCairnStore } from "@/store";
import { useChatStream } from "@/hooks/useChatStream";
import { MarkdownContent } from "@/components/chat/chat-panel/MarkdownContent";
import { QuestionForm } from "@/components/chat/chat-panel/QuestionForm";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PrdModalProps {
  projectId: string;
  workspaceId: string;
  onClose: () => void;
}

type Message =
  | { role: "user";      content: string }
  | { role: "assistant"; content: string };

// ── Component ─────────────────────────────────────────────────────────────────

export function PrdModal({ projectId, workspaceId, onClose }: PrdModalProps) {
  const aiConfig = useCairnStore((s) => s.aiConfig);

  // Use a stable ephemeral thread ID scoped to this modal session
  const threadId = `prd-${projectId}`;

  const {
    isLoading, toolCalls, streamingContent,
    pendingQuestions, sendStream, stopStream,
  } = useChatStream(threadId);

  const [input, setInput]     = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [done, setDone]       = useState(false);

  const inputRef   = useRef<HTMLTextAreaElement>(null);
  const scrollRef  = useRef<HTMLDivElement>(null);
  const historyRef = useRef<Message[]>([]);

  useEffect(() => { historyRef.current = messages; }, [messages]);

  // Auto-scroll on any content change
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, streamingContent, toolCalls, pendingQuestions]);

  // Focus input on mount
  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 80); }, []);

  // Capture completed assistant turns to build local message history
  useEffect(() => {
    if (!isLoading && streamingContent === "" && toolCalls.length === 0) return;
  }, [isLoading, streamingContent, toolCalls]);

  // Track when agent finishes — done when a create_note or ensure_note tool call
  // completed successfully during this session (the PRD was actually saved).
  const noteWritten = useRef(false);
  useEffect(() => {
    if (toolCalls.some((tc) => (tc.tool === "create_note" || tc.tool === "ensure_note") && tc.status === "done")) {
      noteWritten.current = true;
    }
  }, [toolCalls]);

  const prevIsLoading = useRef(false);
  useEffect(() => {
    if (prevIsLoading.current && !isLoading && noteWritten.current) {
      setDone(true);
    }
    prevIsLoading.current = isLoading;
  }, [isLoading]);

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;

    const userMsg: Message = { role: "user", content: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");

    const history = historyRef.current.map((m) => ({ role: m.role, content: m.content }));

    sendStream({
      message: trimmed,
      threadId,
      projectId,
      workspaceId,
      history,
      config: {
        baseUrl:  aiConfig.baseUrl  || "https://api.openai.com",
        model:    aiConfig.model    || "gpt-4o-mini",
        apiKey:   aiConfig.apiKey   || "",
        maxSteps: aiConfig.maxSteps ?? 20,
      },
      systemPrompt: buildPrdSystemPrompt(projectId),
    });
  }, [isLoading, threadId, projectId, workspaceId, aiConfig, sendStream]);

  // Mirror completed assistant turns into local message list so we can
  // show the full conversation history. We listen to the done event via
  // the isLoading transition and read the streamingContent snapshot.
  const lastStreamRef = useRef("");
  useEffect(() => { lastStreamRef.current = streamingContent; }, [streamingContent]);
  useEffect(() => {
    if (prevIsLoading.current && !isLoading && lastStreamRef.current === "" ) {
      // Content was committed by useChatStream's onDone — re-read from history
      // We can't access it here, so we track via a separate effect below
    }
  }, [isLoading]);

  // Simpler: subscribe to onDone ourselves just to capture assistant content
  // into local messages (useChatStream already persists to the thread store,
  // but we need it in our local messages array for display in this modal).
  useEffect(() => {
    const electron = window.electron;
    if (!electron) return;
    const unsub = electron.chat.onDone((e) => {
      // chat:done doesn't include threadId — this subscription is intentionally
      // unscoped but low-risk since prd-${projectId} threads are exclusive to this modal.
      if (e.content) {
        setMessages((prev) => [...prev, { role: "assistant", content: e.content }]);
      }
    });
    return () => { unsub(); };
  }, []);

  const isEmpty = messages.length === 0 && !isLoading;
  const waitingForUser = !isLoading && !done && messages.some((m) => m.role === "assistant");

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !isLoading) { stopStream(); onClose(); } }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 size={14} className="text-[var(--accent)]" />
            Generate PRD
          </DialogTitle>
        </DialogHeader>

        {/* ── Conversation area ── */}
        <div
          ref={scrollRef}
          className="px-4 overflow-y-auto flex flex-col gap-3 py-2"
          style={{ minHeight: "200px", maxHeight: "54vh" }}
        >
          {isEmpty && (
            <div className="flex-1 flex items-center justify-center py-10">
              <p className="text-xs text-[var(--text-tertiary)] text-center max-w-[260px] leading-relaxed">
                Describe what you want to build. The agent will read your project context, ask a few questions, then write and save the PRD.
              </p>
            </div>
          )}

          {messages.map((msg, i) => (
            msg.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[88%] px-3 py-2 rounded-xl rounded-tr-sm text-sm bg-[var(--accent)] text-white">
                  <MarkdownContent content={msg.content} />
                </div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div className="max-w-[88%] px-3 py-2 rounded-xl rounded-tl-sm text-sm bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)]">
                  <MarkdownContent content={msg.content} />
                </div>
              </div>
            )
          ))}

          {/* ── Inline question form ── */}
          {pendingQuestions && (
            <QuestionForm
              questions={pendingQuestions}
              onSubmit={(text) => send(text)}
              disabled={isLoading}
            />
          )}

          {/* ── Live indicator while agent is working ── */}
          {isLoading && (
            <div className="flex justify-start">
              <div className="max-w-[88%] bg-[var(--surface-2)] border border-[var(--border)] rounded-xl rounded-tl-sm px-3 py-2 flex flex-col gap-1.5">
                {toolCalls.map((tc, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-[0.714rem] text-[var(--text-tertiary)]">
                    <CheckCircle2 size={10} className="text-[var(--accent)] flex-shrink-0" />
                    <span>{tc.label}</span>
                  </div>
                ))}
                {streamingContent ? (
                  <div className="text-sm text-[var(--text-primary)]">
                    <MarkdownContent content={streamingContent} />
                    <span className="inline-block w-0.5 h-3 bg-[var(--accent)] animate-pulse ml-0.5 align-middle" />
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-[0.714rem] text-[var(--text-tertiary)]">
                    {toolCalls.length > 0
                      ? <Wrench size={10} className="animate-pulse flex-shrink-0" />
                      : <Loader2 size={10} className="animate-spin flex-shrink-0" />}
                    <span>{toolCalls.length > 0 ? "Working…" : "Thinking…"}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Input row ── */}
        <div className="px-4 pb-4 pt-2 border-t border-[var(--border-subtle)]">
          {done ? (
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--text-tertiary)]">PRD saved to your notes.</span>
              <Button variant="accent" size="sm" onClick={onClose}>Open notes</Button>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {waitingForUser && (
                <p className="text-[0.714rem] text-[var(--accent)] font-medium">Your turn ↓</p>
              )}
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); }
                  }}
                  placeholder={messages.length === 0 ? "Describe what you want to build…" : "Reply…"}
                  disabled={isLoading}
                  rows={1}
                  className={cn(
                    "flex-1 px-3 py-2 text-sm rounded-lg bg-[var(--surface-2)] border text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-dim)] resize-none disabled:opacity-50 transition-colors",
                    waitingForUser
                      ? "border-[var(--accent)]"
                      : "border-[var(--border)] focus:border-[var(--accent)]",
                  )}
                  style={{ minHeight: "36px", maxHeight: "120px" }}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = Math.min(el.scrollHeight, 120) + "px";
                  }}
                />
                <Button
                  variant="accent" size="sm"
                  onClick={() => send(input)}
                  disabled={isLoading || !input.trim()}
                  className="flex-shrink-0"
                >
                  {isLoading ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── PRD system prompt ─────────────────────────────────────────────────────────

function buildPrdSystemPrompt(projectId: string): string {
  return `You are an expert product manager helping write a Product Requirements Document (PRD).

## Your workflow — follow this order exactly

1. **Gather context first.**
   Call get_project_context_pack with projectId="${projectId}" immediately.
   Scan the returned notes for architecture docs, tech specs, or anything describing the product or stack.
   Call get_note on any relevant notes to read their full content.

2. **Ask clarifying questions using the ask_questions tool.**
   Do NOT write questions as prose. You MUST call the ask_questions tool with 2–4 targeted questions.
   Each question needs: id (short snake_case key), label (short title), prompt (one-sentence question as placeholder text).
   Be specific — do not ask things you can already infer from context.

3. **Wait for answers.**
   The user will fill in each question inline and submit them together as a single message.
   Do not write the PRD until you receive their answers. If they say "skip", proceed immediately.

4. **Write the PRD** as a thorough markdown document with these sections:
   # <title>
   ## Overview
   ## Problem Statement
   ## Goals & Non-Goals
   ## User Stories
   ## Functional Requirements
   ## Non-Functional Requirements
   ## Acceptance Criteria
   ## Open Questions

5. **Save it** by calling create_note with:
   - projectId: "${projectId}"
   - title: the PRD title
   - content: the full markdown
   - folder: "PRDs"
   After saving, reply with one short sentence confirming the note title. Do not repeat the markdown.

## Constraints
- Never ask the user for IDs.
- Always use the ask_questions tool — never write questions as prose.
- PRD content must be specific and actionable, not generic boilerplate.

Tone: direct and concise, like a senior PM pairing with the user.`;
}
