"use client";

import React, { useRef } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface TabOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  title?: string;
}

interface TabsProps<T extends string> {
  options: ReadonlyArray<TabOption<T>>;
  value: T;
  onChange: (value: T) => void;
  size?: "md" | "xs";
  ariaLabel?: string;
  className?: string;
}

/**
 * Single tab-row primitive (pill tabs in a surface-2 well). Replaces the
 * copy-pasted `role="tablist"` rows in settings-view (AI / Extensions /
 * System subtabs) and the subagent scope pills. Session tab chrome
 * (AgentSessionTab / AIChatTab / TerminalTab, with close buttons and menus)
 * is structurally different and stays bespoke.
 */
export function Tabs<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  ariaLabel,
  className,
}: TabsProps<T>) {
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusTab = (index: number) => {
    const count = options.length;
    const next = ((index % count) + count) % count;
    btnRefs.current[next]?.focus();
    if (options[next].value !== value) onChange(options[next].value);
  };

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        focusTab(index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        focusTab(index - 1);
        break;
      case "Home":
        e.preventDefault();
        focusTab(0);
        break;
      case "End":
        e.preventDefault();
        focusTab(options.length - 1);
        break;
    }
  };

  return (
    <div role="tablist" aria-label={ariaLabel} className={cn("flex gap-1 p-1 bg-[var(--surface-2)] rounded-lg w-fit", className)}>
      {options.map((opt, i) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => { btnRefs.current[i] = el; }}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={opt.title}
            onClick={() => { if (!active) onChange(opt.value); }}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "font-medium rounded-md transition-colors flex items-center gap-1.5",
              size === "md" && "px-3 py-1.5 text-xs",
              size === "xs" && "px-2 py-0.5 text-[0.643rem]",
              active
                ? "bg-[var(--surface)] text-[var(--text-primary)] shadow-sm"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
