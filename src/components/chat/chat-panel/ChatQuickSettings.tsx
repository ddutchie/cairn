"use client";

import React, { useState, useCallback } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Settings2, GitBranch, ExternalLink, ChevronRight } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { Toggle } from "@/components/ui/toggle";
import { ChatThemePicker } from "@/components/ui/chat-theme-picker";

const MAX_STEPS_PRESETS = [10, 20, 30, 50, 1000] as const;
const TEMPERATURE_PRESETS = [0.1, 0.3, 0.5, 0.7, 1.0] as const;

/**
 * In-chat quick-settings popover. Surfaces the handful of AI settings people
 * change *while chatting* — max steps, temperature, subagents — editing the
 * SAME global aiConfig as Settings → AI & Chat (no per-thread overrides).
 * Provider & model moved out: the ProviderModelPicker row below the input is
 * the always-in-reach way to switch those. The full endpoint / API-key / MCP
 * surface stays in Settings behind the "More settings…" link.
 *
 * `disabled` mirrors the toolbar's isLoading guard so settings can't be changed
 * mid-stream.
 */
export function ChatQuickSettings({ disabled }: { disabled?: boolean }) {
  const { aiConfig, setAIConfig, setSettingsSection, setView } = useCairnStore(
    useShallow((s) => ({
      aiConfig: s.aiConfig,
      setAIConfig: s.setAIConfig,
      setSettingsSection: s.setSettingsSection,
      setView: s.setView,
    })),
  );

  const [open, setOpen] = useState(false);
  // The chat-theme grid is the only section with its own scroll/height (built-ins
  // + community swatches), so it collapses under a chevron to keep the popover
  // compact. Defaults open on first use; the toggle is just for when you want it
  // out of the way.
  const [themesOpen, setThemesOpen] = useState(true);

  const provider = aiConfig.provider ?? "openai";
  const subagentsSupported = provider !== "localllm";

  const openFullSettings = useCallback(() => {
    setSettingsSection("ai");
    setView("settings");
    setOpen(false);
  }, [setSettingsSection, setView]);

  const maxSteps = aiConfig.maxSteps ?? 30;
  const temperature = aiConfig.temperature ?? 0.3;
  const temperatureAuto = aiConfig.temperature == null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip content="Chat settings — steps, temperature, subagents" side="left">
        <Popover.Trigger asChild>
          <button
            aria-label="Chat settings"
            className={cn(
              "flex items-center justify-center p-1 rounded transition-colors",
              open
                ? "text-[var(--accent)] bg-[var(--surface-3)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-3)]",
            )}
          >
            <Settings2 size={12} />
          </button>
        </Popover.Trigger>
      </Tooltip>

      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={6}
          className="z-50 w-64 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl p-3 space-y-3 animate-fade-in focus:outline-none"
        >
          <div className="text-[0.643rem] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            Chat settings
          </div>

          {/* Max steps */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[0.714rem] text-[var(--text-secondary)]">Max steps</span>
              <span className="text-[0.643rem] text-[var(--text-tertiary)]">
                {maxSteps === 1000 ? "∞" : maxSteps} tool rounds
              </span>
            </div>
            <div className="flex gap-1">
              {MAX_STEPS_PRESETS.map((n) => (
                <button
                  key={n}
                  onClick={() => setAIConfig({ maxSteps: n })}
                  disabled={disabled}
                  className={cn(
                    "flex-1 px-1 py-0.5 text-[0.643rem] rounded border transition-colors disabled:opacity-50",
                    maxSteps === n
                      ? "border-[var(--accent)] text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]"
                      : "border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-3)]",
                  )}
                >
                  {n === 1000 ? "∞" : n}
                </button>
              ))}
            </div>
          </div>

          {/* Temperature */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[0.714rem] text-[var(--text-secondary)]">Temperature</span>
              <span className="text-[0.643rem] text-[var(--text-tertiary)]">
                {temperatureAuto ? "Auto (model default)" : temperature.toFixed(2)}
              </span>
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => setAIConfig({ temperature: undefined })}
                disabled={disabled}
                title="Auto — no temperature is sent; the model uses its own default."
                className={cn(
                  "flex-1 px-1 py-0.5 text-[0.643rem] rounded border transition-colors disabled:opacity-50",
                  temperatureAuto
                    ? "border-[var(--accent)] text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]"
                    : "border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-3)]",
                )}
              >
                Auto
              </button>
              {TEMPERATURE_PRESETS.map((n) => (
                <button
                  key={n}
                  onClick={() => setAIConfig({ temperature: n })}
                  disabled={disabled}
                  className={cn(
                    "flex-1 px-1 py-0.5 text-[0.643rem] rounded border transition-colors disabled:opacity-50",
                    !temperatureAuto && temperature === n
                      ? "border-[var(--accent)] text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]"
                      : "border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-3)]",
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          {/* Chat theme — collapsible because the swatch grid (built-ins +
              community themes) is the tallest section. */}
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => setThemesOpen((v) => !v)}
              aria-expanded={themesOpen}
              className="flex w-full items-center justify-between rounded px-0.5 py-0.5 text-[0.714rem] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            >
              <span>Chat theme</span>
              <ChevronRight
                size={12}
                className={cn("text-[var(--text-tertiary)] transition-transform", themesOpen && "rotate-90")}
              />
            </button>
            {themesOpen && <ChatThemePicker variant="grid" className="w-full" />}
          </div>

          {/* Subagents (cloud only) */}
          {subagentsSupported && (
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="flex items-center gap-1.5 text-[0.714rem] text-[var(--text-secondary)]">
                <GitBranch size={11} className="text-[var(--text-tertiary)]" />
                Subagents
              </span>
              <Toggle
                checked={aiConfig.subagentsEnabled ?? false}
                onCheckedChange={(v) => setAIConfig({ subagentsEnabled: v })}
                disabled={disabled}
                label="Enable subagents"
              />
            </div>
          )}

          <button
            onClick={openFullSettings}
            className="flex items-center gap-1.5 w-full pt-2 mt-1 border-t border-[var(--border-subtle)] text-[0.643rem] text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors"
          >
            <ExternalLink size={10} />
            More settings…
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
