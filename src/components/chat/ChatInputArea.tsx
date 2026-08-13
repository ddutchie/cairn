"use client";

/**
 * ChatInputArea — the shared input used by Chat, the Agent pane, and the
 * Overview's pinned launcher. Owns attachment staging (image/PDF → dataUrl),
 * the provider · model picker row, and the status/hint line, so the three
 * surfaces can never drift.
 *
 * Submits via `onSubmit(text, attachments)` — attachments are the staged items
 * at the moment of send (the caller decides how to serialize them for its own
 * request/transcript path).
 */

import React, { useState, useCallback } from "react";
import { ChatInput, type SlashCommand, type SuggestionItem } from "@/components/chat/ChatInput";
import { ProviderModelPicker } from "@/components/ui/provider-model-picker";
import { PersonalityPicker } from "@/components/ui/personality-picker";
import { readAttachments, type AttachmentItem } from "@/lib/read-attachments";
import { cn } from "@/lib/utils";

export interface ChatInputAreaProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (text: string, attachments: AttachmentItem[]) => void;
  onStop?: () => void;
  isLoading?: boolean;
  disabled?: boolean;
  placeholder: string;
  variant?: "default" | "overview";
  showSparkles?: boolean;
  commands?: SlashCommand[];
  suggestions?: SuggestionItem[];
  onSearchSuggestions?: (query: string) => Promise<SuggestionItem[]>;
  allowImages?: boolean;
  allowPdf?: boolean;
  /** Which config the provider · model picker edits ("ai" | "agent"). */
  providerModelTarget?: "ai" | "agent";
  /** Status/hint line shown right-aligned in the footer row. */
  statusText?: string;
  /** Optional trailing node in the footer row (e.g. the On-Device Llama badge). */
  footerTrailing?: React.ReactNode;
  /** Allow sending while a turn runs — the caller queues the message. */
  queueWhileBusy?: boolean;
  /** Messages already queued behind the current turn (shown as a badge). */
  queuedCount?: number;
  className?: string;
}

export const ChatInputArea = React.forwardRef<HTMLTextAreaElement, ChatInputAreaProps>(function ChatInputArea(
  {
    value,
    onChange,
    onSubmit,
    onStop,
    isLoading = false,
    disabled = false,
    placeholder,
    variant = "default",
    showSparkles = false,
    commands,
    suggestions,
    onSearchSuggestions,
    allowImages = false,
    allowPdf = false,
    providerModelTarget,
    statusText,
    footerTrailing,
    queueWhileBusy = false,
    queuedCount = 0,
    className,
  },
  ref,
) {
  const [pendingImages, setPendingImages] = useState<AttachmentItem[]>([]);

  const handleAttach = useCallback(async (files: File[]) => {
    const items = await readAttachments(files, { allowImages, allowPdf });
    setPendingImages((prev) => [...prev, ...items]);
  }, [allowImages, allowPdf]);

  const handleRemove = useCallback((index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSubmit = useCallback(() => {
    // Nothing to send (no text, no staged attachments) → keep the staged
    // attachments: clearing them here would drop them even though nothing was
    // actually submitted.
    if (!value.trim() && pendingImages.length === 0) return;
    setPendingImages([]);
    onSubmit(value, pendingImages);
  }, [onSubmit, value, pendingImages]);

  return (
    <div className={className}>
      <ChatInput
        ref={ref}
        value={value}
        onChange={onChange}
        onSubmit={handleSubmit}
        onStop={onStop}
        isLoading={isLoading}
        disabled={disabled}
        placeholder={placeholder}
        variant={variant}
        showSparkles={showSparkles}
        commands={commands}
        suggestions={suggestions}
        onSearchSuggestions={onSearchSuggestions}
        pendingImages={pendingImages}
        onRemoveImage={handleRemove}
        onAttachImages={handleAttach}
        allowImages={allowImages}
        allowPdf={allowPdf}
        queueWhileBusy={queueWhileBusy}
        queuedCount={queuedCount}
      />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 mt-2">
        {providerModelTarget && <ProviderModelPicker target={providerModelTarget} disabled={disabled} />}
        {providerModelTarget === "ai" && <PersonalityPicker disabled={disabled} />}
        {statusText && (
          <p className={cn("text-[0.643rem] text-[var(--text-tertiary)] ml-auto shrink-0", isLoading && "text-[var(--text-secondary)]")}>
            {statusText}
          </p>
        )}
        {footerTrailing}
      </div>
    </div>
  );
});
