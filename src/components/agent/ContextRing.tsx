"use client";

import React, { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { X } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import type { TokenBreakdown } from "@/types";

interface ContextRingProps {
  promptTokens: number;
  contextLimit: number;
  breakdown?: TokenBreakdown;
  /** Ring diameter in px. Default 16. */
  size?: number;
  /** Stroke width in px. Default 2. */
  stroke?: number;
}

export function ContextRing({
  promptTokens,
  contextLimit,
  breakdown,
  size = 16,
  stroke = 2,
}: ContextRingProps) {
  const [isOpen, setIsOpen] = useState(false);

  const pct  = Math.min(promptTokens / contextLimit, 1);
  const r    = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = pct * circ;

  const colour =
    pct > 0.85 ? "var(--danger)" :
    pct > 0.65 ? "var(--warning, #f59e0b)" :
    "var(--accent)";

  const pctLabel = `${Math.round(pct * 100)}%`;

  const system = breakdown?.systemPrompt ?? Math.min(promptTokens, 1500);
  const tools = breakdown?.tools ?? 0;
  const rules = breakdown?.rules ?? 0;
  const skills = breakdown?.skills ?? 0;
  const mcp = breakdown?.mcp ?? 0;
  const subagent = breakdown?.subagentDefinitions ?? 0;
  const toolOutputs = breakdown?.toolOutputs ?? 0;
  const conversation = breakdown?.conversation ?? Math.max(0, promptTokens - system - toolOutputs);

  const categories = [
    { label: "System prompt", count: system, colorClass: "bg-gray-500" },
    { label: "Tool definitions", count: tools, colorClass: "bg-purple-500" },
    { label: "Rules", count: rules, colorClass: "bg-emerald-500" },
    { label: "Skills", count: skills, colorClass: "bg-amber-500" },
    { label: "MCP", count: mcp, colorClass: "bg-pink-500" },
    { label: "Subagent definitions", count: subagent, colorClass: "bg-blue-500" },
    { label: "Conversation", count: conversation, colorClass: "bg-teal-500" },
    { label: "Tool outputs", count: toolOutputs, colorClass: "bg-indigo-500" },
  ];

  function formatTokenCount(num: number): string {
    if (num >= 1000) {
      return `${(num / 1000).toFixed(1).replace(/\.0$/, "")}K`;
    }
    return num.toString();
  }

  const ringSvg = (
    <div className="cursor-pointer select-none flex-shrink-0 hover:opacity-80 transition-opacity flex items-center justify-center">
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none"
          stroke="var(--border)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none"
          stroke={colour}
          strokeWidth={stroke}
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
          style={{ transition: "stroke-dasharray 0.4s ease, stroke 0.4s ease" }}
        />
      </svg>
    </div>
  );

  const trigger = (
    <Popover.Trigger asChild>
      {ringSvg}
    </Popover.Trigger>
  );

  return (
    <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
      {isOpen ? (
        trigger
      ) : (
        <Tooltip
          content={`Context: ${promptTokens.toLocaleString()} / ${contextLimit.toLocaleString()} tokens (${pctLabel})`}
          side="bottom"
        >
          {trigger}
        </Tooltip>
      )}
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={8}
          className="z-50 w-72 rounded-xl bg-[var(--surface-3)] border border-[var(--border)] p-4 shadow-2xl text-xs text-[var(--text-secondary)] select-none focus:outline-none animate-fade-in"
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-[var(--text-primary)] text-[0.85rem]">Context Usage</span>
            <Popover.Close asChild>
              <button className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors p-1 rounded hover:bg-[var(--surface-4)] focus:outline-none cursor-pointer">
                <X size={12} />
              </button>
            </Popover.Close>
          </div>

          {/* Info row */}
          <div className="flex items-center justify-between text-[0.714rem]">
            <span className="font-medium text-[var(--text-primary)]">{pctLabel} Full</span>
            <span className="text-[var(--text-tertiary)]">
              ~{formatTokenCount(promptTokens)} / {formatTokenCount(contextLimit)} Tokens
            </span>
          </div>

          {/* Segmented bar */}
          <div className="w-full h-1.5 bg-[var(--surface-4)] rounded-full overflow-hidden flex my-3">
            {categories.map((c) => {
              const widthPct = (c.count / contextLimit) * 100;
              if (widthPct <= 0) return null;
              return (
                <div
                  key={c.label}
                  style={{ width: `${widthPct}%` }}
                  className={`h-full ${c.colorClass} transition-all duration-300`}
                  title={`${c.label}: ${c.count.toLocaleString()} tokens`}
                />
              );
            })}
          </div>

          {/* Legend */}
          <div className="space-y-1.5 mt-2">
            {categories.map((c) => {
              if (c.count === 0 && (c.label === "Rules" || c.label === "MCP")) return null;
              return (
                <div key={c.label} className="flex items-center justify-between text-[0.714rem]">
                  <div className="flex items-center gap-1.5">
                    <div className={`w-2.5 h-2.5 rounded-sm ${c.colorClass} opacity-90`} />
                    <span className="text-[var(--text-secondary)]">{c.label}</span>
                  </div>
                  <span className="font-mono text-[var(--text-primary)] font-medium">
                    {formatTokenCount(c.count)}
                  </span>
                </div>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
