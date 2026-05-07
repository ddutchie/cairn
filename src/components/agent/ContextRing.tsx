"use client";

import React from "react";
import { Tooltip } from "@/components/ui/tooltip";

interface ContextRingProps {
  promptTokens: number;
  contextLimit: number;
  /** Ring diameter in px. Default 16. */
  size?: number;
  /** Stroke width in px. Default 2. */
  stroke?: number;
}

export function ContextRing({ promptTokens, contextLimit, size = 16, stroke = 2 }: ContextRingProps) {
  const pct  = Math.min(promptTokens / contextLimit, 1);
  const r    = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = pct * circ;

  const colour =
    pct > 0.85 ? "var(--danger)" :
    pct > 0.65 ? "var(--warning, #f59e0b)" :
    "var(--accent)";

  const pctLabel = `${Math.round(pct * 100)}%`;

  return (
    <Tooltip
      content={`Context: ${promptTokens.toLocaleString()} / ${contextLimit.toLocaleString()} tokens (${pctLabel})`}
      side="bottom"
    >
      <div className="cursor-default select-none flex-shrink-0">
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
    </Tooltip>
  );
}
