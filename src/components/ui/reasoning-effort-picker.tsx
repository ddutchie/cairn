"use client";

/**
 * ReasoningEffortPicker — a compact "how hard should the model think?" control
 * shown next to the provider · model and personality pickers in the chat/agent
 * input. Only rendered for reasoning-capable models (models.dev `reasoning:
 * true`); other models ignore/reject the field so the pill is hidden.
 *
 * Effort maps 1:1 onto the harness's ReasoningEffortId (Responses
 * `reasoning.effort` / completions `reasoning_effort`). Selection is global on
 * the target config (aiConfig for chat, agentConfig for the coding agent), like
 * the model picker it sits beside. "Auto" (undefined) = the model's own default.
 */

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Gauge, ChevronDown, X } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { getModelInfo } from "@/lib/models-dev";
import type { ReasoningEffort } from "@/store/slices/ui";

export interface ReasoningEffortPickerProps {
  /** Which config this pill drives — chat (aiConfig) or the coding agent. */
  target: "ai" | "agent";
  disabled?: boolean;
  align?: "start" | "center" | "end";
  size?: "xs" | "sm";
  className?: string;
}

/** Ordered options. `undefined` = Auto (send nothing; the model's own default).
 *  Values use the pi-ai/dsh thinking vocabulary; low/medium/high are supported
 *  by every reasoning model, and "off" omits the reasoning option entirely. */
const OPTIONS: Array<{ value: ReasoningEffort | undefined; label: string; hint: string }> = [
  { value: undefined, label: "Auto", hint: "The model's own default effort" },
  { value: "off", label: "Off", hint: "No thinking — fastest, smallest replies" },
  { value: "low", label: "Low", hint: "Brief reasoning — good for everyday chat" },
  { value: "medium", label: "Medium", hint: "Balanced reasoning" },
  { value: "high", label: "High", hint: "Thorough reasoning — slower, more thinking" },
];

export function ReasoningEffortPicker({
  target,
  disabled,
  align = "end",
  size = "xs",
  className,
}: ReasoningEffortPickerProps) {
  const { aiModel, agentModel, aiEffort, agentEffort, setAIConfig, setAgentConfig } = useCairnStore(
    useShallow((s) => ({
      aiModel: s.aiConfig.model,
      agentModel: s.agentConfig.model,
      aiEffort: s.aiConfig.reasoningEffort,
      agentEffort: s.agentConfig.reasoningEffort,
      setAIConfig: s.setAIConfig,
      setAgentConfig: s.setAgentConfig,
    })),
  );

  const [open, setOpen] = useState(false);

  const model = target === "ai" ? aiModel : agentModel;
  const effort = target === "ai" ? aiEffort : agentEffort;

  // Only reasoning-capable models accept an effort — hide the pill otherwise.
  if (getModelInfo(model)?.reasoning !== true) return null;

  const active = OPTIONS.find((o) => o.value === effort) ?? OPTIONS[0];
  const triggerPad = size === "xs" ? "px-1.5 py-0.5 text-[0.643rem]" : "px-2 py-1 text-[0.714rem]";

  const select = (value: ReasoningEffort | undefined) => {
    if (target === "ai") setAIConfig({ reasoningEffort: value });
    else setAgentConfig({ reasoningEffort: value });
    setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip content="Reasoning effort" side="top">
        <Popover.Trigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label="Reasoning effort"
            title={`Reasoning effort: ${active.label}`}
            className={cn(
              "flex items-center gap-1 rounded-md border border-[var(--border)] text-[var(--text-secondary)] transition-colors",
              "hover:bg-[var(--surface-2)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50",
              triggerPad,
              className,
            )}
          >
            <Gauge size={11} className="shrink-0 text-[var(--text-tertiary)]" />
            <span className="max-w-[6rem] truncate">{active.label}</span>
            <ChevronDown size={11} className="text-[var(--text-tertiary)] shrink-0" />
          </button>
        </Popover.Trigger>
      </Tooltip>

      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align={align}
          sideOffset={6}
          className="z-50 w-64 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl p-3 space-y-2 animate-fade-in focus:outline-none"
        >
          <div className="flex items-center justify-between">
            <div className="text-[0.643rem] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
              {target === "ai" ? "Chat" : "Agent"} · reasoning effort
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            >
              <X size={13} />
            </button>
          </div>

          <div className="flex flex-col gap-0.5">
            {OPTIONS.map((o) => {
              const isActive = o.value === effort;
              return (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => select(o.value)}
                  className={cn(
                    "flex items-start gap-1.5 w-full px-2 py-1.5 rounded-md text-left text-[0.714rem] transition-colors",
                    isActive
                      ? "text-[var(--accent)] bg-[var(--accent-dim)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="font-medium">{o.label}</span>
                      {o.value === undefined && (
                        <span className="text-[0.6rem] text-[var(--text-tertiary)] border border-[var(--border)] rounded px-1 leading-3">default</span>
                      )}
                    </span>
                    <span className="block text-[0.6rem] text-[var(--text-tertiary)] mt-0.5">{o.hint}</span>
                  </span>
                  {isActive && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] flex-shrink-0 mt-1.5" />}
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
