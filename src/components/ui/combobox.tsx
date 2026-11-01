"use client";

/**
 * Combobox — a searchable picker on the Popover surface.
 *
 * Same trigger as `Select` and the same selected-row treatment (accent-dim
 * fill + check gutter), plus a search field that filters as you type. Arrow
 * keys move through the results without leaving the field
 * (aria-activedescendant), Enter picks, Escape clears the query and then
 * closes. Options can be grouped and can carry a secondary line and a trailing
 * slot (e.g. a timestamp).
 */

import React, { useId, useMemo, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { FOCUS_RING } from "./button";
import { cn } from "@/lib/utils";

export interface ComboboxOption<V extends string> {
  value: V;
  label: string;
  /** Secondary line under the label. */
  description?: React.ReactNode;
  icon?: React.ReactNode;
  /** Right-aligned meta (timestamp, count). */
  trailing?: React.ReactNode;
  /** Options sharing a group render under one muted heading, in first-seen order. */
  group?: string;
  /** Extra text matched by the search but not shown. */
  keywords?: string;
  disabled?: boolean;
}

export interface ComboboxProps<V extends string> {
  value: V | null;
  options: ComboboxOption<V>[];
  onChange: (value: V) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Required: names the trigger and the listbox for assistive tech. */
  ariaLabel: string;
  /** Custom trigger content; defaults to the selected option's icon + label. */
  renderTrigger?: (selected: ComboboxOption<V> | undefined) => React.ReactNode;
  size?: "sm" | "md";
  align?: "start" | "center" | "end";
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const SIZE_CLASSES = {
  sm: "px-2.5 py-1.5 text-xs",
  md: "px-2.5 py-2 text-sm",
} as const;

function matches<V extends string>(option: ComboboxOption<V>, query: string): boolean {
  if (!query) return true;
  return `${option.label} ${option.keywords ?? ""}`.toLowerCase().includes(query.toLowerCase());
}

export function Combobox<V extends string>({
  value,
  options,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search",
  emptyText = "No matches",
  ariaLabel,
  renderTrigger,
  size = "sm",
  align = "start",
  disabled,
  className,
  contentClassName,
  open: openProp,
  onOpenChange,
}: ComboboxProps<V>) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();

  const selected = options.find((o) => o.value === value);
  const visible = useMemo(() => options.filter((o) => matches(o, query.trim())), [options, query]);
  const enabled = visible.filter((o) => !o.disabled);

  function setOpen(next: boolean) {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
    if (next) {
      const start = enabled.findIndex((o) => o.value === value);
      setActiveIndex(start >= 0 ? start : 0);
    } else {
      setQuery("");
    }
  }

  function pick(option: ComboboxOption<V>) {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
  }

  function scrollToActive(index: number) {
    const id = enabled[index] && optionId(enabled[index].value);
    if (id) document.getElementById(id)?.scrollIntoView?.({ block: "nearest" });
  }

  const optionId = (v: V) => `${listId}-opt-${v}`;

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!enabled.length) return;
      const next = (activeIndex + (e.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
      setActiveIndex(next);
      scrollToActive(next);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const next = e.key === "Home" ? 0 : enabled.length - 1;
      setActiveIndex(next);
      scrollToActive(next);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const option = enabled[activeIndex];
      if (option) pick(option);
    }
  }

  // Group in first-seen order; ungrouped options come first.
  const groups: Array<{ name: string | undefined; items: ComboboxOption<V>[] }> = [];
  for (const option of visible) {
    const g = groups.find((x) => x.name === option.group);
    if (g) g.items.push(option);
    else groups.push({ name: option.group, items: [option] });
  }
  const active = enabled[activeIndex];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            "flex min-w-0 items-center justify-between gap-1.5 rounded-md border border-[var(--border)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50",
            FOCUS_RING,
            open && "bg-[var(--surface-2)]",
            SIZE_CLASSES[size],
            className,
          )}
        >
          {renderTrigger ? renderTrigger(selected) : (
            <span className="flex min-w-0 items-center gap-1.5">
              {selected?.icon && <span className="flex-shrink-0 text-[var(--text-tertiary)]">{selected.icon}</span>}
              <span className="truncate text-left text-[var(--text-primary)]">{selected?.label ?? placeholder}</span>
            </span>
          )}
          <ChevronDown size={12} className={cn("flex-shrink-0 text-[var(--text-tertiary)] transition-transform", open && "rotate-180")} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        matchTriggerWidth
        className={cn("flex max-h-80 min-w-[16rem] flex-col overflow-hidden", contentClassName)}
        onEscapeKeyDown={(e) => {
          // First Escape clears the query; the next one closes. Radix listens
          // on the document, so this has to happen here, not on the input.
          if (!query) return;
          e.preventDefault();
          setQuery("");
          setActiveIndex(0);
        }}
        onOpenAutoFocus={(e) => {
          // Focus the search field rather than the first focusable child.
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>("input")?.focus();
        }}
      >
        <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-2">
          <Search size={12} className="flex-shrink-0 text-[var(--text-tertiary)]" />
          <input
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active ? optionId(active.value) : undefined}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
            onKeyDown={onKeyDown}
            placeholder={searchPlaceholder}
            className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
          />
        </div>
        <div id={listId} role="listbox" aria-label={ariaLabel} className="min-h-0 flex-1 overflow-y-auto py-1">
          {visible.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-[var(--text-tertiary)]">{emptyText}</p>
          ) : groups.map((g) => (
            <div key={g.name ?? "_"} role={g.name ? "group" : undefined} aria-label={g.name}>
              {g.name && <div className="px-3 pb-1 pt-2 text-xs font-medium text-[var(--text-tertiary)]">{g.name}</div>}
              {g.items.map((option) => {
                const isSelected = option.value === value;
                const isActive = active?.value === option.value;
                return (
                  <div
                    key={option.value}
                    id={optionId(option.value)}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    onPointerMove={() => {
                      const i = enabled.findIndex((o) => o.value === option.value);
                      if (i >= 0 && i !== activeIndex) setActiveIndex(i);
                    }}
                    onClick={() => pick(option)}
                    className={cn(
                      "mx-1 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs",
                      option.disabled && "cursor-not-allowed opacity-40",
                      isSelected ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--text-secondary)]",
                      isActive && !isSelected && "bg-[var(--surface-2)] text-[var(--text-primary)]",
                    )}
                  >
                    <span className="flex w-4 flex-shrink-0 items-center justify-center">
                      {isSelected ? <Check size={12} /> : option.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate", !isSelected && "text-[var(--text-primary)]")}>{option.label}</span>
                      {option.description && <span className="block truncate text-2xs text-[var(--text-tertiary)]">{option.description}</span>}
                    </span>
                    {option.trailing && <span className="flex-shrink-0 text-2xs text-[var(--text-tertiary)]">{option.trailing}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
