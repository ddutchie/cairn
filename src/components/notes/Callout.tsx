"use client";

/**
 * Callout — renders Obsidian-style callout blocks in the preview pane.
 *
 * Syntax: > [!type] Optional title
 *         > body text
 *
 * Collapsible variant: > [!type]+ Title
 *                      > body text  (starts open)
 *
 *                      > [!type]- Title
 *                      > body text  (starts closed)
 *
 * Supported types: note, info, tip, warning, danger/caution, success/check/done, question/faq, quote/cite
 */

import React, { useState } from "react";
import {
  Info,
  Lightbulb,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  HelpCircle,
  Quote,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type CalloutType =
  | "note"
  | "info"
  | "tip"
  | "warning"
  | "danger"
  | "caution"
  | "success"
  | "check"
  | "done"
  | "question"
  | "faq"
  | "quote"
  | "cite"
  | string;

interface CalloutProps {
  type: CalloutType;
  title?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function getCalloutConfig(type: CalloutType): {
  icon: React.ReactNode;
  colorVar: string;
} {
  const t = type.toLowerCase();
  if (t === "tip") {
    return { icon: <Lightbulb size={14} />, colorVar: "var(--success)" };
  }
  if (t === "warning") {
    return { icon: <AlertTriangle size={14} />, colorVar: "var(--warning, #f59e0b)" };
  }
  if (t === "danger" || t === "caution") {
    return { icon: <AlertCircle size={14} />, colorVar: "var(--danger, #ef4444)" };
  }
  if (t === "success" || t === "check" || t === "done") {
    return { icon: <CheckCircle2 size={14} />, colorVar: "var(--success)" };
  }
  if (t === "question" || t === "faq") {
    return { icon: <HelpCircle size={14} />, colorVar: "var(--accent)" };
  }
  if (t === "quote" || t === "cite") {
    return { icon: <Quote size={14} />, colorVar: "var(--text-secondary)" };
  }
  // note / info / fallback
  return { icon: <Info size={14} />, colorVar: "var(--accent)" };
}

export function Callout({ type, title, collapsible, defaultOpen = true, children }: CalloutProps) {
  const [open, setOpen] = useState(defaultOpen);
  const { icon, colorVar } = getCalloutConfig(type);
  const displayTitle = title || type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();

  return (
    <div
      className="my-3 rounded-lg border overflow-hidden"
      style={{
        borderColor: `color-mix(in srgb, ${colorVar} 30%, transparent)`,
        background: `color-mix(in srgb, ${colorVar} 8%, var(--surface))`,
      }}
    >
      {/* Header */}
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-2 select-none",
          collapsible && "cursor-pointer hover:bg-[var(--surface-2)] transition-colors"
        )}
        style={{ color: colorVar }}
        onClick={collapsible ? () => setOpen((o) => !o) : undefined}
      >
        <span className="flex-shrink-0">{icon}</span>
        <span className="text-[0.786rem] font-semibold flex-1">{displayTitle}</span>
        {collapsible && (
          <ChevronDown
            size={13}
            className={cn("transition-transform flex-shrink-0", !open && "-rotate-90")}
          />
        )}
      </div>

      {/* Body */}
      {(!collapsible || open) && (
        <div className="px-3 pb-3 pt-0.5 text-[var(--text-secondary)] text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Parse a blockquote's first-child paragraph to detect `[!type]` syntax.
 * Returns null if not a callout.
 */
export function parseCalloutDirective(rawText: string): {
  type: string;
  title: string;
  collapsible: boolean;
  defaultOpen: boolean;
} | null {
  // Match [!type], [!type]+, [!type]-, [!type] Optional title, etc.
  const match = rawText.match(/^\[!([^\]]+)\]([\+\-]?)(.*)$/);
  if (!match) return null;
  const [, type, modifier, rest] = match;
  const collapsible = modifier === "+" || modifier === "-";
  const defaultOpen = modifier !== "-";
  const title = rest.trim();
  return { type: type.trim().toLowerCase(), title, collapsible, defaultOpen };
}
