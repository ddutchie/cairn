"use client";

import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { ChevronDown, RefreshCw, Check, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown";

/**
 * A single-line, truncated label that shows the app Tooltip with the full text
 * ONLY when the text is actually cut off (scrollWidth > clientWidth). Avoids a
 * pointless tooltip on names that already fit.
 */
export function TruncatedModel({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setOverflowing(el.scrollWidth > el.clientWidth);
  }, [text]);

  const span = (
    <span ref={ref} className={cn("truncate block min-w-0 flex-1", className)}>
      {text}
    </span>
  );

  if (!overflowing) return span;
  return (
    <Tooltip content={text} side="top">
      {span}
    </Tooltip>
  );
}

export interface ModelPickerProps {
  value: string;
  options: string[];
  loading: boolean;
  errored: boolean;
  disabled?: boolean;
  placeholder?: string;
  onChange: (model: string) => void;
  onRefresh: () => void;
  /** Visual density. "sm" = compact (chat popover); "md" = settings-row size. */
  size?: "sm" | "md";
  /** Dropdown alignment (default "start"). */
  align?: "start" | "center" | "end";
  className?: string;
}

/**
 * Model selector used across the app (chat quick-settings popover + settings
 * endpoint rows + saved-provider form). Uses the shared Radix dropdown for a
 * consistent floating panel + click-away, listing the endpoint's fetched models
 * with a Refresh action to re-query and a "Custom model…" affordance for typing
 * any model id the endpoint didn't list.
 */
export function ModelPicker({
  value,
  options,
  loading,
  errored,
  disabled,
  placeholder,
  onChange,
  onRefresh,
  size = "sm",
  align = "start",
  className,
}: ModelPickerProps) {
  // Custom-entry mode: a free-text input for a model id not in the list.
  const [custom, setCustom] = useState(false);
  const customRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (custom) customRef.current?.focus(); }, [custom]);

  const triggerPad = size === "md" ? "px-2.5 py-1.5 text-xs" : "px-2 py-1 text-[0.714rem]";

  if (custom) {
    return (
      <div className={cn("flex gap-1", className)}>
        <input
          ref={customRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") setCustom(false); }}
          disabled={disabled}
          placeholder={placeholder}
          className={cn(
            "flex-1 min-w-0 font-mono rounded-md border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] disabled:opacity-50",
            triggerPad,
          )}
        />
        <Tooltip content="Done" side="top">
          <button
            onClick={() => setCustom(false)}
            className="flex items-center justify-center px-1.5 rounded-md border border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--accent)] hover:bg-[var(--surface-3)] transition-colors"
          >
            <Check size={12} />
          </button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className={cn("flex gap-1", className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            className={cn(
              "flex-1 min-w-0 flex items-center justify-between gap-1 rounded-md border bg-[var(--surface-2)] text-[var(--text-primary)] transition-colors disabled:opacity-50",
              triggerPad,
              errored ? "border-[var(--danger)]" : "border-[var(--border)] hover:border-[var(--muted)]",
            )}
          >
            {value ? (
              <TruncatedModel text={value} className="font-mono" />
            ) : (
              <span className="truncate font-sans text-[var(--text-tertiary)]">
                {placeholder || "Select model"}
              </span>
            )}
            <ChevronDown size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="max-w-[240px] max-h-64 overflow-y-auto">
          <DropdownMenuItem
            onSelect={(e) => { e.preventDefault(); onRefresh(); }}
            className="text-[var(--text-secondary)]"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            {loading ? "Refreshing…" : "Refresh models"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setCustom(true)}>
            <Pencil size={12} />
            Custom model…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {errored && (
            <div className="px-2.5 py-1.5 text-[0.643rem] text-[var(--danger)]">
              Couldn&apos;t load models — check the endpoint.
            </div>
          )}
          {options.length === 0 && !errored && (
            <div className="px-2.5 py-1.5 text-[0.643rem] text-[var(--text-tertiary)]">
              No models — Refresh or add a custom one.
            </div>
          )}
          {options.map((m) => (
            <DropdownMenuItem
              key={m}
              onSelect={() => onChange(m)}
              className={cn("font-mono text-xs", m === value && "text-[var(--accent)]")}
            >
              <span className="w-3.5 flex-shrink-0">
                {m === value && <Check size={12} />}
              </span>
              <TruncatedModel text={m} />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
