"use client";

import React, { useRef, useEffect, useState, useMemo } from "react";
import { Send, Square, Sparkles, FileText, CheckSquare, FileCode, Image, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

export interface SlashCommand {
  name: string;
  description: string;
  insertText: string;
}

export interface SuggestionItem {
  id: string;
  type: "note" | "card" | "file";
  title: string;
  subtitle?: string;
}

interface ChatInputProps {
  value: string;
  onChange: (val: string) => void;
  onSubmit: () => void;
  placeholder: string;
  isLoading?: boolean;
  onStop?: () => void;
  disabled?: boolean;
  variant?: "default" | "overview";
  showSparkles?: boolean;
  autoFocus?: boolean;
  commands?: SlashCommand[];
  suggestions?: SuggestionItem[];
  onSearchSuggestions?: (query: string) => Promise<SuggestionItem[]>;
  /** Attachments staged but not yet sent — shown as a thumbnail strip (kind
   *  "pdf" renders as a file chip; anything else as an image thumbnail). */
  pendingImages?: Array<{ name: string; dataUrl: string; kind?: "image" | "pdf" }>;
  onRemoveImage?: (index: number) => void;
  onAttachImages?: (files: File[]) => void;
  /** When false, image attach is hidden (selected model has no image input). */
  allowImages?: boolean;
  /** When true the file picker also accepts PDFs (model supports pdf input, or
   *  image input can rasterize them as a fallback). */
  allowPdf?: boolean;
  /** When true, sending while a turn is running is allowed — the caller queues
   *  the message and sends it when the current reply finishes. Keeps the send
   *  button visible next to Stop and lets Enter submit while busy. */
  queueWhileBusy?: boolean;
  /** Number of messages already queued behind the current turn (shown on the
   *  send button as a badge while busy). */
  queuedCount?: number;
}

export const ChatInput = React.forwardRef<HTMLTextAreaElement, ChatInputProps>(
  (
    {
      value,
      onChange,
      onSubmit,
      placeholder,
      isLoading = false,
      onStop,
      disabled = false,
      variant = "default",
      showSparkles = false,
      autoFocus = false,
      commands = [],
      suggestions = [],
      onSearchSuggestions,
      pendingImages,
      onRemoveImage,
      onAttachImages,
      allowImages = true,
      allowPdf = false,
      queueWhileBusy = false,
      queuedCount = 0,
    },
    ref
  ) => {
    const internalRef = useRef<HTMLTextAreaElement>(null);
    const resolvedRef = (ref as React.RefObject<HTMLTextAreaElement>) || internalRef;
    const fileInputRef = useRef<HTMLInputElement>(null);
    // After selecting a command/mention we suppress trigger re-scans for a short
    // window, otherwise a completed slash command (e.g. "/compact") re-detects the
    // '/' at index 0 and re-opens the palette — swallowing the follow-up Enter meant
    // to send. A timestamp (not a one-shot bool) covers the multiple events
    // (onChange RAF, onKeyUp, onSelect) that fire around a single selection.
    const suppressTriggerUntilRef = useRef(0);

    const [showSuggestions, setShowSuggestions] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const [trigger, setTrigger] = useState<{ type: "command" | "mention"; query: string; index: number } | null>(null);
    const [asyncSuggestions, setAsyncSuggestions] = useState<SuggestionItem[]>([]);

    // Parser to scan backward from the cursor for a trigger ('/' at start, or '@' preceded by space/newline/start)
    const getActiveTrigger = () => {
      const el = resolvedRef.current;
      if (!el) return null;
      
      const text = value;
      const pos = el.selectionStart;
      
      let i = pos - 1;
      while (i >= 0 && text[i] !== " " && text[i] !== "\n") {
        if (text[i] === "@") {
          if (i === 0 || text[i - 1] === " " || text[i - 1] === "\n") {
            const query = text.slice(i + 1, pos);
            return { type: "mention" as const, query, index: i };
          }
        }
        if (text[i] === "/" && i === 0) {
          const query = text.slice(i + 1, pos);
          return { type: "command" as const, query, index: i };
        }
        i--;
      }
      return null;
    };

    const checkTrigger = () => {
      requestAnimationFrame(() => {
        // Skip scans briefly after a selection so the palette doesn't immediately reopen.
        if (Date.now() < suppressTriggerUntilRef.current) {
          return;
        }
        const active = getActiveTrigger();
        setTrigger(active);
      });
    };

    // Filter commands based on trigger
    const filteredCommands = useMemo(() => {
      if (trigger?.type !== "command") return [];
      const q = trigger.query.toLowerCase();
      return commands.filter((cmd) => cmd.name.toLowerCase().includes(q));
    }, [commands, trigger]);

    // Handle async search suggestions with debounce
    useEffect(() => {
      if (trigger?.type !== "mention" || !onSearchSuggestions) {
        setAsyncSuggestions([]);
        return;
      }

      const query = trigger.query;
      const delayDebounce = setTimeout(async () => {
        const results = await onSearchSuggestions(query);
        setAsyncSuggestions(results);
      }, 150);

      return () => clearTimeout(delayDebounce);
    }, [trigger, onSearchSuggestions]);

    // Filter local suggestions or use async suggestions
    const filteredSuggestions = useMemo(() => {
      if (trigger?.type !== "mention") return [];
      if (onSearchSuggestions) {
        return asyncSuggestions;
      }
      if (!suggestions) return [];
      const q = trigger.query.toLowerCase();
      return suggestions.filter((item) =>
        item.title.toLowerCase().includes(q)
      );
    }, [suggestions, trigger, onSearchSuggestions, asyncSuggestions]);

    // Show suggestions only when there are matching entries
    useEffect(() => {
      const hasOptions = trigger?.type === "command"
        ? filteredCommands.length > 0
        : filteredSuggestions.length > 0;

      if (hasOptions) {
        setShowSuggestions(true);
        const listLength = trigger?.type === "command" ? filteredCommands.length : filteredSuggestions.length;
        setActiveIndex((prev) => Math.min(prev, listLength - 1));
      } else {
        setShowSuggestions(false);
        setActiveIndex(0);
      }
    }, [filteredCommands, filteredSuggestions, trigger]);

    const handleSelectCommand = (cmd: SlashCommand) => {
      if (!trigger) return;
      const before = value.slice(0, trigger.index);
      const after = value.slice(resolvedRef.current?.selectionEnd ?? value.length);
      onChange(before + cmd.insertText + after);
      // Close the palette and stop trigger scans from reopening it, so a
      // completed command is ready to send on the next Enter press.
      suppressTriggerUntilRef.current = Date.now() + 250;
      setShowSuggestions(false);
      setTrigger(null);
      const newCursorPos = before.length + cmd.insertText.length;
      resolvedRef.current?.focus();
      setTimeout(() => {
        if (resolvedRef.current) {
          resolvedRef.current.selectionStart = newCursorPos;
          resolvedRef.current.selectionEnd = newCursorPos;
        }
      }, 0);
    };

    const handleSelectSuggestion = (item: SuggestionItem) => {
      if (!trigger) return;
      const before = value.slice(0, trigger.index);
      const after = value.slice(resolvedRef.current?.selectionEnd ?? value.length);
      const insertedText = item.type === "file" ? `\`${item.title}\`` : `[[${item.title}]]`;
      onChange(before + insertedText + after);
      suppressTriggerUntilRef.current = Date.now() + 250;
      setShowSuggestions(false);
      setTrigger(null);
      resolvedRef.current?.focus();
      const newCursorPos = trigger.index + insertedText.length;
      setTimeout(() => {
        if (resolvedRef.current) {
          resolvedRef.current.selectionStart = newCursorPos;
          resolvedRef.current.selectionEnd = newCursorPos;
        }
      }, 0);
    };

    // Auto-resize height based on contents
    useEffect(() => {
      const el = resolvedRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }, [value, variant, resolvedRef]);

    // Focus on mount if autoFocus is true
    useEffect(() => {
      if (autoFocus && resolvedRef.current) {
        resolvedRef.current.focus();
      }
    }, [autoFocus, resolvedRef]);

    const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData.items;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        if (!allowImages) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        onAttachImages?.(imageFiles);
      }
    };

    const handleAttachClick = () => {
      fileInputRef.current?.click();
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        onAttachImages?.(Array.from(files));
      }
      e.target.value = "";
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const listLength = trigger?.type === "command" ? filteredCommands.length : filteredSuggestions.length;
      if (showSuggestions && listLength > 0 && trigger) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveIndex((prev) => (prev + 1) % listLength);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveIndex((prev) => (prev - 1 + listLength) % listLength);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          if (trigger.type === "command") {
            handleSelectCommand(filteredCommands[activeIndex]);
          } else {
            handleSelectSuggestion(filteredSuggestions[activeIndex]);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setShowSuggestions(false);
          setTrigger(null);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        // While busy, submitting is allowed only when the caller queues.
        if (!disabled && value.trim() && (!isLoading || queueWhileBusy)) {
          onSubmit();
        }
      }
    };

    const isOverview = variant === "overview";

    return (
      <div className="relative w-full">
        {/* Hidden file input for image/PDF attachment */}
        <input
          ref={fileInputRef}
          type="file"
          accept={[allowImages && "image/*", allowPdf && "application/pdf,.pdf"].filter(Boolean).join(",") || undefined}
          multiple
          onChange={handleFileChange}
          className="hidden"
        />

        {/* Attachment preview strip */}
        {pendingImages && pendingImages.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {pendingImages.map((img, i) => (
              <div key={i} className="relative group">
                {img.kind === "pdf" ? (
                  <div
                    className="w-16 h-16 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] flex flex-col items-center justify-center gap-1 px-1"
                    title={img.name}
                  >
                    <FileText size={18} className="text-[var(--danger)]" />
                    <span className="text-[0.5rem] leading-none text-[var(--text-tertiary)] truncate w-full text-center">
                      {img.name}
                    </span>
                  </div>
                ) : (
                  <img
                    src={img.dataUrl}
                    alt={img.name}
                    className="w-16 h-16 object-cover rounded-lg border border-[var(--border)]"
                  />
                )}
                <button
                  onClick={() => onRemoveImage?.(i)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-[var(--danger)] text-[var(--surface)] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Autocomplete suggestions */}
        {showSuggestions && trigger && (
          <div className="absolute bottom-full left-0 right-0 mb-1.5 z-50 bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden max-h-56 overflow-y-auto animate-in fade-in slide-in-from-bottom-2 duration-150">
            <div className="px-3 py-1.5 border-b border-[var(--border)] bg-[var(--surface-2)] flex items-center justify-between">
              <span className="text-[0.643rem] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                {trigger.type === "command" ? "Slash Commands" : "Mention Note / Task / File"}
              </span>
              <span className="text-[0.571rem] text-[var(--text-tertiary)]">
                ↑↓ to navigate · Enter to select
              </span>
            </div>
            <div className="p-1">
              {trigger.type === "command"
                ? filteredCommands.map((cmd, index) => {
                    const isActive = index === activeIndex;
                    return (
                      <button
                        key={cmd.name}
                        type="button"
                        onClick={() => handleSelectCommand(cmd)}
                        className={cn(
                          "w-full text-left px-2.5 py-2 rounded-lg flex flex-col gap-0.5 transition-colors",
                          isActive
                            ? "bg-[var(--accent-dim)] text-[var(--accent)]"
                            : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                        )}
                      >
                        <span className="text-xs font-semibold">/{cmd.name}</span>
                        <span className="text-[0.643rem] text-[var(--text-tertiary)]">
                          {cmd.description}
                        </span>
                      </button>
                    );
                  })
                : filteredSuggestions.map((item, index) => {
                    const isActive = index === activeIndex;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => handleSelectSuggestion(item)}
                        className={cn(
                          "w-full text-left px-2.5 py-2 rounded-lg flex items-center justify-between gap-3 transition-colors",
                          isActive
                            ? "bg-[var(--accent-dim)] text-[var(--accent)]"
                            : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                        )}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {item.type === "note" ? (
                            <FileText size={12} className="text-[var(--info)] shrink-0" />
                          ) : item.type === "file" ? (
                            <FileCode size={12} className="text-[var(--warning,#f59e0b)] shrink-0" />
                          ) : (
                            <CheckSquare size={12} className="text-[var(--accent)] shrink-0" />
                          )}
                          <span className="text-xs font-semibold truncate">
                            {item.title}
                          </span>
                        </div>
                        <span className="text-[0.643rem] text-[var(--text-tertiary)] shrink-0">
                          {item.subtitle}
                        </span>
                      </button>
                    );
                  })}
            </div>
          </div>
        )}

        <div
          className={cn(
            "relative flex items-end gap-2.5 transition-all duration-300",
            isOverview
              ? "rounded-2xl border border-[var(--border)] bg-[color-mix(in srgb,var(--surface-2)_85%,transparent)] backdrop-blur-md px-4 py-3 shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:border-[color-mix(in srgb,var(--accent)_40%,transparent)] focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[var(--accent-dim)]"
              : "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[var(--accent-dim)]"
          )}
        >
          {showSparkles && (
            <div className="flex-shrink-0 w-8 h-8 rounded-xl bg-[var(--accent-dim)] text-[var(--accent)] flex items-center justify-center animate-pulse self-center">
              <Sparkles size={14} />
            </div>
          )}

          <textarea
            ref={resolvedRef}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              checkTrigger();
            }}
            onPaste={handlePaste}
            onKeyDown={handleKeyDown}
            onKeyUp={checkTrigger}
            onSelect={checkTrigger}
            placeholder={placeholder}
            rows={1}
            disabled={disabled}
            className={cn(
              "flex-1 bg-transparent text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none py-1.5 leading-relaxed resize-none overflow-y-auto max-h-32 disabled:opacity-60",
              "font-[family-name:var(--chat-font)]",
              isOverview ? "text-sm min-h-[36px]" : "text-xs min-h-[32px]"
            )}
          />

          <div className="flex items-center gap-1.5 flex-shrink-0 self-center">
            {!isLoading && (allowImages || allowPdf) && (
              <Tooltip content="Attach image or PDF" side="left">
                <button
                  onClick={handleAttachClick}
                  type="button"
                  disabled={disabled}
                  className={cn(
                    "flex-shrink-0 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--accent)] hover:bg-[var(--surface-3)] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-all duration-200",
                    isOverview ? "w-8 h-8 rounded-xl" : "w-7 h-7"
                  )}
                >
                  {/* eslint-disable-next-line jsx-a11y/alt-text -- lucide icon component, not <img> */}
                  <Image size={isOverview ? 13 : 12} />
                </button>
              </Tooltip>
            )}
            {isLoading && onStop ? (
              <>
                {queueWhileBusy && (
                  <Tooltip
                    content={queuedCount > 0
                      ? `${queuedCount} message${queuedCount === 1 ? "" : "s"} queued — sending adds to the queue`
                      : "Queue message — sends when the current reply finishes"}
                    side="left"
                  >
                    <button
                      onClick={onSubmit}
                      disabled={disabled || (!value.trim() && (!pendingImages || pendingImages.length === 0))}
                      type="button"
                      className={cn(
                        "relative flex-shrink-0 rounded-lg bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[color-mix(in_srgb,var(--accent)_90%,var(--background))] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-all duration-200 hover:scale-105 active:scale-95 shadow-md shadow-[color-mix(in_srgb,var(--accent)_10%,transparent)]",
                        isOverview ? "w-8 h-8 rounded-xl" : "w-7 h-7"
                      )}
                    >
                      <Send size={isOverview ? 13 : 12} />
                      {queuedCount > 0 && (
                        <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-[var(--surface-3)] border border-[var(--border)] text-[0.571rem] font-semibold text-[var(--text-secondary)] flex items-center justify-center leading-none">
                          {queuedCount}
                        </span>
                      )}
                    </button>
                  </Tooltip>
                )}
                <Tooltip content="Stop generation" side="left">
                  <button
                    onClick={onStop}
                    type="button"
                    className={cn(
                      "flex-shrink-0 rounded-lg bg-[var(--danger)] text-white hover:bg-[color-mix(in srgb,var(--danger)_90%,black)] flex items-center justify-center transition-all duration-200 hover:scale-105 active:scale-95 shadow-md shadow-[var(--danger)]/10",
                      isOverview ? "w-8 h-8 rounded-xl" : "w-7 h-7"
                    )}
                  >
                    <Square size={isOverview ? 11 : 10} fill="currentColor" />
                  </button>
                </Tooltip>
              </>
            ) : (
              <Tooltip content="Send (Enter)" side="left">
                <button
                  onClick={onSubmit}
                  disabled={disabled || (!value.trim() && (!pendingImages || pendingImages.length === 0))}
                  type="button"
                  className={cn(
                    "flex-shrink-0 rounded-lg bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[color-mix(in_srgb,var(--accent)_90%,var(--background))] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-all duration-200 hover:scale-105 active:scale-95 shadow-md shadow-[color-mix(in_srgb,var(--accent)_10%,transparent)]",
                    isOverview ? "w-8 h-8 rounded-xl" : "w-7 h-7"
                  )}
                >
                  <Send size={isOverview ? 13 : 12} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    );
  }
);

ChatInput.displayName = "ChatInput";

