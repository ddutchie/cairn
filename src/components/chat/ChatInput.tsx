"use client";

import React, { useRef, useEffect } from "react";
import { Send, Square, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

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
    },
    ref
  ) => {
    const internalRef = useRef<HTMLTextAreaElement>(null);
    const resolvedRef = (ref as React.RefObject<HTMLTextAreaElement>) || internalRef;

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

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!disabled && !isLoading && value.trim()) {
          onSubmit();
        }
      }
    };

    const isOverview = variant === "overview";

    return (
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
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={disabled}
          className={cn(
            "flex-1 bg-transparent text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none py-1.5 leading-relaxed resize-none overflow-y-auto max-h-32 disabled:opacity-60",
            isOverview ? "text-sm min-h-[36px]" : "text-xs min-h-[32px]"
          )}
        />

        <div className="flex items-center gap-2 flex-shrink-0 self-center">
          {isLoading && onStop ? (
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
          ) : (
            <Tooltip content="Send (Enter)" side="left">
              <button
                onClick={onSubmit}
                disabled={disabled || !value.trim()}
                type="button"
                className={cn(
                  "flex-shrink-0 rounded-lg bg-[var(--accent)] text-white hover:bg-[color-mix(in srgb,var(--accent)_90%,black)] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-all duration-200 hover:scale-105 active:scale-95 shadow-md shadow-[var(--accent)]/10",
                  isOverview ? "w-8 h-8 rounded-xl" : "w-7 h-7"
                )}
              >
                <Send size={isOverview ? 13 : 12} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    );
  }
);

ChatInput.displayName = "ChatInput";

