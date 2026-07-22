"use client";

import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { Settings2, GitBranch, ExternalLink, ChevronDown, RefreshCw, Check, Pencil } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { Toggle } from "@/components/ui/toggle";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown";
import { useEndpointConfig, isLocalBaseUrl, LOCAL_FALLBACK_MODELS } from "@/components/settings/endpoint-components";

const MAX_STEPS_PRESETS = [10, 20, 30, 50, 1000] as const;
const CLOUD_FALLBACK_MODELS = ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "gpt-4", "o1-mini", "o3-mini"];

/**
 * In-chat quick-settings popover. Surfaces the handful of AI settings people
 * change *while chatting* — model, max steps, temperature, subagents — editing
 * the SAME global aiConfig as Settings → AI & Chat (no per-thread overrides).
 * The full endpoint / API-key / MCP surface stays in Settings behind the
 * "More settings…" link. Replaces the old inline Subagents pill.
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
  const rootRef = useRef<HTMLDivElement>(null);
  const { availableModels, fetchModels, modelsLoading, testState } = useEndpointConfig();

  const provider = aiConfig.provider ?? "openai";
  const isLocal = isLocalBaseUrl(aiConfig.baseUrl);
  const subagentsSupported = provider !== "localllm";

  // Fetch the endpoint's model list once when the popover opens (cloud only).
  // Users can re-fetch anytime via the Refresh action in the model picker.
  useEffect(() => {
    if (open && provider !== "localllm") {
      fetchModels(aiConfig.baseUrl, aiConfig.apiKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Close on outside click / Escape. The model picker uses a Radix dropdown
  // whose content is PORTALED outside rootRef — clicking a model item must not
  // close the whole popover, so ignore clicks landing inside any Radix popper.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest("[data-radix-popper-content-wrapper]")) return;
      if (rootRef.current && !rootRef.current.contains(target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const openFullSettings = useCallback(() => {
    setSettingsSection("ai");
    setView("settings");
    setOpen(false);
  }, [setSettingsSection, setView]);

  const modelOptions = availableModels.length > 0
    ? availableModels
    : (isLocal ? LOCAL_FALLBACK_MODELS : CLOUD_FALLBACK_MODELS);

  const maxSteps = aiConfig.maxSteps ?? 30;
  const temperature = aiConfig.temperature ?? 0.3;

  return (
    <div ref={rootRef} className="relative">
      <Tooltip content="Chat settings — model, steps, temperature, subagents" side="left">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label="Chat settings"
          aria-expanded={open}
          className={cn(
            "flex items-center justify-center p-1 rounded transition-colors",
            open
              ? "text-[var(--accent)] bg-[var(--surface-3)]"
              : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-3)]",
          )}
        >
          <Settings2 size={12} />
        </button>
      </Tooltip>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-64 z-50 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl p-3 space-y-3 animate-fade-in"
          role="dialog"
        >
          <div className="text-[0.643rem] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            Chat settings
          </div>

          {/* Model */}
          <div className="space-y-1">
            <span className="text-[0.714rem] text-[var(--text-secondary)]">Model</span>
            <ModelPicker
              value={aiConfig.model ?? ""}
              options={modelOptions}
              loading={modelsLoading}
              errored={testState === "error"}
              disabled={disabled}
              placeholder={isLocal ? "local model" : "gpt-4o-mini"}
              onChange={(m) => setAIConfig({ model: m })}
              onRefresh={() => fetchModels(aiConfig.baseUrl, aiConfig.apiKey)}
            />
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
          <label className="block space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[0.714rem] text-[var(--text-secondary)]">Temperature</span>
              <span className="text-[0.643rem] text-[var(--text-tertiary)]">{temperature.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={temperature}
              onChange={(e) => setAIConfig({ temperature: parseFloat(e.target.value) })}
              disabled={disabled}
              className="w-full accent-[var(--accent)] disabled:opacity-50"
            />
          </label>

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
        </div>
      )}
    </div>
  );
}

/**
 * A single-line, truncated label that shows the app Tooltip with the full text
 * ONLY when the text is actually cut off (scrollWidth > clientWidth). Avoids a
 * pointless tooltip on names that already fit.
 */
function TruncatedModel({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setOverflowing(el.scrollWidth > el.clientWidth);
  }, [text]);

  const span = (
    <span ref={ref} className={cn("truncate block min-w-0 flex-1", className)}>
      {text}
    </span>
  );

  if (!overflowing) return span;
  return (
    <Tooltip content={text} side="top">
      {span}
    </Tooltip>
  );
}

/**
 * Compact model selector for the quick-settings popover. Uses the shared Radix
 * dropdown (consistent floating panel + click-away) to pick from the endpoint's
 * fetched models, with a Refresh action to re-query the endpoint and a
 * "Custom model…" affordance for typing any model id the endpoint didn't list.
 */
function ModelPicker({
  value,
  options,
  loading,
  errored,
  disabled,
  placeholder,
  onChange,
  onRefresh,
}: {
  value: string;
  options: string[];
  loading: boolean;
  errored: boolean;
  disabled?: boolean;
  placeholder?: string;
  onChange: (model: string) => void;
  onRefresh: () => void;
}) {
  // Custom-entry mode: a free-text input for a model id not in the list.
  const [custom, setCustom] = useState(false);
  const customRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (custom) customRef.current?.focus(); }, [custom]);

  if (custom) {
    return (
      <div className="flex gap-1">
        <input
          ref={customRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") setCustom(false); }}
          disabled={disabled}
          placeholder={placeholder}
          className="flex-1 min-w-0 px-2 py-1 text-[0.714rem] font-mono rounded-md border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] disabled:opacity-50"
        />
        <Tooltip content="Done" side="top">
          <button
            onClick={() => setCustom(false)}
            className="flex items-center justify-center px-1.5 rounded-md border border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--accent)] hover:bg-[var(--surface-3)] transition-colors"
          >
            <Check size={12} />
          </button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="flex gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            className={cn(
              "flex-1 min-w-0 flex items-center justify-between gap-1 px-2 py-1 text-[0.714rem] rounded-md border bg-[var(--surface-2)] text-[var(--text-primary)] transition-colors disabled:opacity-50",
              errored ? "border-[var(--danger)]" : "border-[var(--border)] hover:border-[var(--muted)]",
            )}
          >
            {value ? (
              <TruncatedModel text={value} className="font-mono" />
            ) : (
              <span className="truncate font-sans text-[var(--text-tertiary)]">
                {placeholder || "Select model"}
              </span>
            )}
            <ChevronDown size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-[240px] max-h-64 overflow-y-auto">
          <DropdownMenuItem
            onSelect={(e) => { e.preventDefault(); onRefresh(); }}
            className="text-[var(--text-secondary)]"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            {loading ? "Refreshing…" : "Refresh models"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setCustom(true)}>
            <Pencil size={12} />
            Custom model…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {errored && (
            <div className="px-2.5 py-1.5 text-[0.643rem] text-[var(--danger)]">
              Couldn&apos;t load models — check the endpoint in settings.
            </div>
          )}
          {options.length === 0 && !errored && (
            <div className="px-2.5 py-1.5 text-[0.643rem] text-[var(--text-tertiary)]">
              No models — Refresh or add a custom one.
            </div>
          )}
          {options.map((m) => (
            <DropdownMenuItem
              key={m}
              onSelect={() => onChange(m)}
              className={cn("font-mono text-xs", m === value && "text-[var(--accent)]")}
            >
              <span className="w-3.5 flex-shrink-0">
                {m === value && <Check size={12} />}
              </span>
              <TruncatedModel text={m} />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
