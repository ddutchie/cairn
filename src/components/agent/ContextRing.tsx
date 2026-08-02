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
  /** Total completion tokens for this turn (answer + reasoning, if any). */
  completionTokens?: number;
  /** Subset of completionTokens spent on reasoning/thinking. 0/undefined if the model didn't split. */
  reasoningTokens?: number;
  /** Provider-reported USD cost of the turn (e.g. Neuralwatt usage.cost), when present. */
  costUsd?: number;
  /** Ring diameter in px. Default 16. */
  size?: number;
  /** Stroke width in px. Default 2. */
  stroke?: number;
}

export function ContextRing({
  promptTokens,
  contextLimit,
  breakdown,
  completionTokens,
  reasoningTokens,
  costUsd,
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

  const thinkingTokens = reasoningTokens ?? 0;
  const answerTokens = Math.max(0, (completionTokens ?? 0) - thinkingTokens);

  const categories = [
    { label: "System prompt", count: system, color: "var(--muted-fg)" },
    { label: "Tool definitions", count: tools, color: "var(--accent)" },
    { label: "Rules", count: rules, color: "var(--text-tertiary)" },
    { label: "Skills", count: skills, color: "var(--warning)" },
    { label: "MCP", count: mcp, color: "var(--border)" },
    { label: "Subagent definitions", count: subagent, color: "var(--info)" },
    { label: "Conversation", count: conversation, color: "var(--success)" },
    { label: "Tool outputs", count: toolOutputs, color: "var(--danger)" },
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
              <button className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors p-1 rounded hover:bg-[var(--surface-2)] focus:outline-none cursor-pointer">
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
          <div className="w-full h-1.5 bg-[var(--border)] rounded-full overflow-hidden flex my-3">
            {categories.map((c) => {
              const widthPct = (c.count / contextLimit) * 100;
              if (widthPct <= 0) return null;
              return (
                <div
                  key={c.label}
                  style={{ width: `${widthPct}%`, backgroundColor: c.color }}
                  className="h-full transition-all duration-300"
                  title={`${c.label}: ${c.count.toLocaleString()} tokens`}
                />
              );
            })}
          </div>

          {/* Legend */}
          <div className="space-y-1.5 mt-2">
            {categories.map((c) => {
              if (c.count === 0 && (c.label === "Rules" || c.label === "MCP" || c.label === "Subagent definitions" || c.label === "Skills")) return null;
              return (
                <div key={c.label} className="flex items-center justify-between text-[0.714rem]">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-sm opacity-90" style={{ backgroundColor: c.color }} />
                    <span className="text-[var(--text-secondary)]">{c.label}</span>
                  </div>
                  <span className="font-mono text-[var(--text-primary)] font-medium">
                    {formatTokenCount(c.count)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Output breakdown — only shown after the first turn completes */}
          {typeof completionTokens === "number" && completionTokens > 0 && (
            <div className="mt-3 pt-3 border-t border-[var(--border)] space-y-1.5">
              <div className="text-[0.714rem] font-semibold text-[var(--text-primary)] mb-1">Output</div>
              <div className="flex items-center justify-between text-[0.714rem]">
                <span className="text-[var(--text-secondary)]">Answer</span>
                <span className="font-mono text-[var(--text-primary)] font-medium">{formatTokenCount(answerTokens)}</span>
              </div>
              {thinkingTokens > 0 && (
                <div className="flex items-center justify-between text-[0.714rem]">
                  <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                    <div className="w-2.5 h-2.5 rounded-sm opacity-90" style={{ backgroundColor: "var(--accent)" }} />
                    Thinking
                  </span>
                  <span className="font-mono text-[var(--text-primary)] font-medium">{formatTokenCount(thinkingTokens)}</span>
                </div>
              )}
              <div className="flex items-center justify-between text-[0.714rem]">
                <span className="text-[var(--text-tertiary)]">Total</span>
                <span className="font-mono text-[var(--text-tertiary)]">{formatTokenCount(completionTokens)}</span>
              </div>
            </div>
          )}

          {/* Cost — only shown when the provider reports a USD cost for the turn */}
          {typeof costUsd === "number" && costUsd > 0 && (
            <div className="mt-3 pt-3 border-t border-[var(--border)] flex items-center justify-between text-[0.714rem]">
              <span className="text-[var(--text-secondary)]">Cost</span>
              <span className="font-mono text-[var(--text-primary)] font-semibold">
                ${costUsd.toFixed(5).replace(/\.?0+$/, "")}
              </span>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
