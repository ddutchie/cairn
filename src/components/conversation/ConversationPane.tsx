"use client";

import React, { useEffect } from "react";
import { ConversationComposer, type ConversationComposerProps } from "./ConversationComposer";
import { ConversationEmptyState } from "./ConversationEmptyState";
import { ConversationHeader } from "./ConversationHeader";
import { ConversationMessageBubble } from "./ConversationMessageBubble";
import { ConversationTranscript } from "./ConversationTranscript";
import type { ConversationMessage } from "./conversation-message";
import type { PendingQuestion } from "@/hooks/useChatStream";
import { QuestionForm } from "@/components/chat/chat-panel/QuestionForm";
import type { ConnectorMeta } from "@/components/shared/ConnectorToolCard";
import type { VirtuosoHandle } from "react-virtuoso";
import type { ConversationUsage } from "./ConversationHeader";
import { cn } from "@/lib/utils";

export interface ConversationProjectionState {
  pendingQuestions?: PendingQuestion[] | null;
  questionCallId?: string | null;
}

export interface ConversationPaneProps {
  sessionId: string;
  profile: string;
  messages: ConversationMessage[];
  input: string;
  onInputChange: (value: string) => void;
  onPrompt: ConversationComposerProps["onSubmit"];
  onAbort: () => void;
  isLoading: boolean;
  /** The pane requests history; profile-specific callers decide how to load it. */
  historyLoader?: () => Promise<ConversationMessage[]>;
  onHistoryLoaded?: (messages: ConversationMessage[]) => void;
  projection?: ConversationProjectionState;
  onAnswerQuestions?: (answers: string) => void;
  title?: React.ReactNode;
  usage?: ConversationUsage;
  contextLimit?: number;
  actions?: React.ReactNode;
  connectors?: Record<string, ConnectorMeta>;
  onRetry?: (content: string) => void;
  centered?: boolean;
  placeholder?: string;
  emptyState?: React.ReactNode;
  transcriptRef?: React.RefObject<VirtuosoHandle | null>;
  transcriptFooter?: React.ComponentType<{ context: unknown }>;
  composerRef?: React.Ref<HTMLTextAreaElement>;
  composerBefore?: React.ReactNode;
  composerProps?: Partial<Omit<ConversationComposerProps, "value" | "onChange" | "onSubmit" | "onStop" | "isLoading" | "placeholder">>;
  className?: string;
}

/** Shared session-bound transcript, blocking surfaces, and composer. */
export function ConversationPane({
  sessionId, profile, messages, input, onInputChange, onPrompt, onAbort, isLoading,
  historyLoader, onHistoryLoaded, projection, onAnswerQuestions, title, contextLimit,
  usage, actions, connectors, onRetry, centered = false, placeholder, emptyState, transcriptRef,
  transcriptFooter, composerRef, composerBefore, composerProps, className,
}: ConversationPaneProps) {
  useEffect(() => {
    if (!historyLoader) return;
    let cancelled = false;
    void historyLoader().then((history) => {
      if (!cancelled) onHistoryLoaded?.(history);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [historyLoader, onHistoryLoaded]);

  const pendingQuestions = projection?.pendingQuestions ?? null;
  const submitQuestions = onAnswerQuestions ?? ((answers: string) => onPrompt(answers, []));

  return (
    <div className={cn("flex flex-1 min-h-0 flex-col overflow-hidden", className)} data-session-profile={profile}>
      <ConversationHeader title={title ?? profile} usage={usage} contextLimit={contextLimit ?? 128000} actions={actions} />
      <span aria-live="polite" aria-atomic="true" className="sr-only">{isLoading ? "Working" : ""}</span>
      <ConversationTranscript
        transcriptRef={transcriptRef}
        className="flex-1 min-h-0"
        data={messages}
        initialTopMostItemIndex={Math.max(0, messages.length - 1)}
        emptyPlaceholder={() => <>{emptyState ?? <ConversationEmptyState />}</>}
        footer={transcriptFooter ?? (() => <div aria-live="polite" aria-atomic="true" className="px-3 py-3 text-xs text-[var(--text-tertiary)]">{isLoading ? "Cairn is working…" : ""}<span className="sr-only">{isLoading ? "Working" : ""}</span></div>)}
        itemContent={(_index, message) => (
          <div className={cn("px-3 py-1.5", centered && "max-w-3xl mx-auto w-full")}>
            <ConversationMessageBubble message={message} sessionId={sessionId} onRetry={onRetry} connectors={connectors} />
          </div>
        )}
      />
      {pendingQuestions && (
        <div className="px-3 pt-3">
          <QuestionForm
            questions={pendingQuestions}
            onSubmit={submitQuestions}
            onSubmitStructured={(answers) => { submitQuestions(answers); return true; }}
          />
        </div>
      )}
      {composerBefore}
      <ConversationComposer
        {...composerProps}
        ref={composerRef}
        value={input}
        onChange={onInputChange}
        onSubmit={onPrompt}
        onStop={onAbort}
        isLoading={isLoading}
        placeholder={placeholder ?? `Ask the ${profile}…`}
      />
    </div>
  );
}
