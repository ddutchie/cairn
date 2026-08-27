"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ContextRing } from "@/components/agent/ContextRing";
import type { TokenBreakdown } from "@/types";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";

export interface ConversationUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  breakdown?: TokenBreakdown;
  costUsd?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

interface ConversationHeaderProps {
  title: ReactNode;
  usage?: ConversationUsage;
  contextLimit: number;
  actions?: ReactNode;
}

/** Shared session header shell; Chat and Coding provide only title/actions. */
export function ConversationHeader({ title, usage, contextLimit, actions }: ConversationHeaderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setOverflows(el.clientWidth < 300));
    ro.observe(el);
    setOverflows(el.clientWidth < 300);
    return () => ro.disconnect();
  }, [title, usage, actions]);

  return (
    <div ref={ref} className="flex items-center gap-1.5 px-3 h-9 border-b border-[var(--border)] bg-[var(--surface-2)] flex-shrink-0 overflow-hidden min-w-0">
      <span className="text-[0.714rem] font-medium text-[var(--text-secondary)] truncate flex-1 min-w-0">{title}</span>
      {usage && <span className="shrink-0 flex items-center"><ContextRing {...usage} contextLimit={contextLimit} /></span>}
      <span className={`items-center gap-1 shrink-0 flex-nowrap ${overflows ? "hidden" : "flex"}`}>{actions}</span>
      {overflows && actions && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="w-7 h-7 rounded-md grid place-items-center border border-[var(--border)] bg-[var(--surface)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:border-[var(--muted)] shrink-0 ml-auto" aria-label="More actions">
              <MoreHorizontal size={12} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="p-2 flex flex-col gap-1 bg-[var(--surface)] border border-[var(--border)]">
            <div className="flex items-center gap-1 flex-wrap">{actions}</div>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
