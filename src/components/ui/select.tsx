"use client";

/**
 * Select — the app's styled dropdown selector.
 *
 * A Radix-dropdown-based replacement for native `<select>` so every dropdown
 * across the app shares the same floating panel, keyboard handling, and theming
 * (no OS-styled listboxes). Used by the usage source filter, chat quick-settings
 * provider, card column/blocker pickers, automations, spawn-agent, llama console,
 * and schedule builder.
 *
 * The trigger always renders the selected option's label (or the placeholder)
 * and a chevron; the menu lists every option with a check gutter for the active
 * one. `onChange` fires with the picked value on selection.
 */

import React from "react";
import { ChevronDown, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown";
import { cn } from "@/lib/utils";

export interface SelectOption<V extends string | number> {
  value: V;
  /** Rendered in both the trigger (when selected) and the menu item. */
  label: React.ReactNode;
  disabled?: boolean;
}

export interface SelectProps<V extends string | number> {
  value: V;
  options: SelectOption<V>[];
  onChange: (value: V) => void;
  placeholder?: React.ReactNode;
  /** Visual density. "sm" = compact (toolbars, settings rows); "md" = form fields. */
  size?: "sm" | "md";
  align?: "start" | "center" | "end";
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  className?: string;
  contentClassName?: string;
}

const SIZE_CLASSES = {
  sm: "px-2 py-1 text-[0.714rem]",
  md: "px-2 py-2 text-sm",
} as const;

export function Select<V extends string | number>({
  value,
  options,
  onChange,
  placeholder,
  size = "sm",
  align = "start",
  disabled,
  id,
  ariaLabel,
  className,
  contentClassName,
}: SelectProps<V>) {
  const selected = options.find((o) => o.value === value);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          aria-label={ariaLabel}
          className={cn(
            "flex items-center justify-between gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-primary)] transition-colors hover:border-[var(--muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:border-[var(--accent)] disabled:opacity-50",
            SIZE_CLASSES[size],
            className
          )}
        >
          <span className="truncate text-left">{selected ? selected.label : (placeholder ?? "Select…")}</span>
          <ChevronDown size={12} className="text-[var(--text-tertiary)] flex-shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className={cn("min-w-[160px] max-h-72 overflow-y-auto", contentClassName)}>
        {options.map((o) => {
          const active = o.value === value;
          return (
            <DropdownMenuItem
              key={String(o.value)}
              disabled={o.disabled}
              onSelect={() => onChange(o.value)}
              className={cn(active && "text-[var(--text-primary)]")}
            >
              <span className="w-4 flex-shrink-0 flex items-center justify-center">
                {active && <Check size={12} className="text-[var(--accent)]" />}
              </span>
              <span className="flex-1 min-w-0">{o.label}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
