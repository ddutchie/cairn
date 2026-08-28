"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { ChatInputArea, type ChatInputAreaProps } from "@/components/chat/ChatInputArea";

export interface ConversationComposerProps extends Omit<ChatInputAreaProps, "className"> {
  /** Centered conversation presentation uses the same content width as the transcript. */
  centered?: boolean;
  className?: string;
}

/** Shared composer frame and input contract for Chat and Coding sessions. */
export const ConversationComposer = React.forwardRef<HTMLTextAreaElement, ConversationComposerProps>(function ConversationComposer(
  { centered = false, className, ...inputProps },
  ref,
) {
  return (
    <div className={cn("border-t border-[var(--border)] p-3 flex-shrink-0", centered && "border-t-0 bg-transparent p-6 max-w-3xl mx-auto w-full", className)}>
      <ChatInputArea ref={ref} {...inputProps} />
    </div>
  );
});
