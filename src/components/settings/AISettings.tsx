"use client";

import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { useEffect, useState } from "react";
import { Cpu, Globe, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { contextLimitForModel, modelInfoForModel } from "@/lib/models-dev";
import { SettingsGroup, SettingsRow, Toggle, StepperSettingsRow } from "./shared";
import { MCPServerSettings } from "./MCPSettings";
import { LlamaServerConsole } from "./LlamaServerConsole";
import { ProviderManager } from "./ProviderManager";
import { BrowseProvidersModal } from "./tools/BrowseProvidersModal";

export function AISettings() {
  const { aiConfig, setAIConfig } = useCairnStore(useShallow((s) => ({
    aiConfig:             s.aiConfig,
    setAIConfig:          s.setAIConfig,
  })));

  // General config destructuring. Connection fields (baseUrl/apiKey/model) are
  // now managed entirely by the ProviderManager switcher below; here we only
  // need `provider` (which backend), `model` (for the context lookup), and the
  // behavioural fields.
  const { provider = "openai", model, aiEnabled } = aiConfig;

  function updateAIConfig(patch: Partial<typeof aiConfig>) {
    setAIConfig(patch);
  }

  // Look up the current model's context window from models.dev (cached). When
  // Auto is enabled, the detected value is applied to contextLimit automatically
  // as the model changes; the user can still override with a manual value or
  // preset (which turns Auto off). Best-effort — null when not in the catalog.
  // Cloud provider only.
  const contextAuto = aiConfig.contextAuto ?? true;
  const [detectedContext, setDetectedContext] = useState<number | null>(null);
  const [autoState, setAutoState] = useState<"idle" | "loading" | "detected" | "not_found">("idle");
  const [browsingProviders, setBrowsingProviders] = useState(false);
  useEffect(() => {
    if (provider === "localllm") return;
    let cancelled = false;
    const id = (model ?? "").trim();
    if (!id) { setDetectedContext(null); setAutoState("idle"); return; } // eslint-disable-line react-hooks/set-state-in-effect
    setAutoState("loading");
    contextLimitForModel(id, 0).then((n) => {
      if (cancelled) return;
      const found = n > 0 ? n : null;
      setDetectedContext(found);
      setAutoState(found ? "detected" : "not_found");
      // Auto-apply the detected value when Auto mode is on. Read the LATEST config
      // from the store (not the captured render value) to avoid stale-closure
      // races when switching models quickly, and only write when it differs.
      if (found) {
        const cur = useCairnStore.getState().aiConfig;
        if ((cur.contextAuto ?? true) && cur.contextLimit !== found) {
          setAIConfig({ contextLimit: found });
        }
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, provider, contextAuto]);

  // Max output tokens. Auto (default) sends NO cap so the model finishes
  // naturally — capping only ever truncates a long reasoning+answer. A manual
  // value is a deliberate cost/latency ceiling. We surface the model's
  // advertised limit.output (when known) as guidance next to the field.
  const maxOutputAuto = aiConfig.maxOutputAuto ?? true;
  const [advertisedMaxOutput, setAdvertisedMaxOutput] = useState<number | null>(null);
  useEffect(() => {
    if (provider === "localllm") return;
    let cancelled = false;
    const id = (model ?? "").trim();
    if (!id) { setAdvertisedMaxOutput(null); return; } // eslint-disable-line react-hooks/set-state-in-effect
    modelInfoForModel(id).then((info) => {
      if (cancelled) return;
      setAdvertisedMaxOutput(info?.maxOutput ?? null);
    });
    return () => { cancelled = true; };
  }, [model, provider]);

  // Shared Max-steps control — rendered after the provider-specific block for
  // both providers (passed into the Llama console so its position is unchanged).
  const maxStepsRow = (
    <StepperSettingsRow
      label="Max steps"
      description="Tool-call rounds the chat can take per message. Increase for complex multi-tool tasks."
      icon="footprints"
      value={aiConfig.maxSteps ?? 30}
      onChange={(v) => updateAIConfig({ maxSteps: v })}
      presets={[10, 20, 30, 50, 1000]}
      min={1}
      max={1000}
      formatPreset={(n) => (n === 1000 ? "∞" : String(n))}
    />
  );

  return (
    <div className="space-y-8">
      {/* ── Inline AI ── */}
      <SettingsGroup
        title="Inline AI"
        description="Control AI features shown in the editor. View visibility (Agent, AI Chat) is managed in General settings."
      >
        <SettingsRow
          label="Enable inline AI"
          description="Shows AI buttons in the editor — text actions, PRD generator, task spawning, and Idea Flow AI summaries. Does not affect the Agent or Chat views."
        >
          <Toggle
            checked={aiEnabled ?? true}
            onChange={(v) => updateAIConfig({ aiEnabled: v })}
            label="Enable inline AI"
          />
        </SettingsRow>
      </SettingsGroup>

      {/* ── General Chat & Inline AI Feature Config ── */}
      <SettingsGroup
        title="General Chat & Inline AI"
        description="Configure endpoints for the main AI Chat panel, in-editor inline text actions, PRD writer, and summaries. Supports offline private models."
      >
        {/* Provider Switcher */}
        <SettingsRow
          label="AI Provider"
          description="Choose between a fully offline on-device model or an OpenAI-compatible cloud / local API connection."
        >
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => updateAIConfig({ provider: "openai" })}
              className={cn(
                "px-3 py-1.5 text-xs rounded-md border transition-all flex items-center gap-2 cursor-pointer whitespace-nowrap",
                provider === "openai"
                  ? "border-[var(--accent)] text-[var(--text-primary)] bg-[var(--accent-dim)] font-medium"
                  : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]"
              )}
            >
              <Globe size={12} />
              OpenAI
            </button>
            <button
              onClick={() => updateAIConfig({ provider: "localllm" })}
              className={cn(
                "px-3 py-1.5 text-xs rounded-md border transition-all flex items-center gap-2 relative cursor-pointer whitespace-nowrap",
                provider === "localllm"
                  ? "border-[var(--accent)] text-[var(--text-primary)] bg-[var(--accent-dim)] font-medium"
                  : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]"
              )}
            >
              <Cpu size={12} className={provider === "localllm" ? "text-[var(--accent)] animate-pulse" : ""} />
              On-Device
            </button>
          </div>
        </SettingsRow>

        {provider === "localllm" ? (
          <LlamaServerConsole
            contextLimit={aiConfig.contextLimit}
            onContextLimitChange={(n) => updateAIConfig({ contextLimit: n })}
            maxStepsRow={maxStepsRow}
          />
        ) : (
          <>
            {/* Install a preset provider from the cairn-community catalog. */}
            <SettingsRow
              label="Community providers"
              description="Install a ready-made OpenAI-compatible provider (endpoint + default model) and just enter your API key. Added to your saved providers below."
            >
              <button
                onClick={() => setBrowsingProviders(true)}
                className="px-2.5 py-1.5 text-[0.714rem] rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                <Download size={12} /> Browse Community
              </button>
            </SettingsRow>

            <ProviderManager kind="ai" />

            {/* Max Steps — applies to all providers */}
            {maxStepsRow}

            {/* Temperature */}
            <StepperSettingsRow
              label="Temperature"
              description="Sampling temperature for chat & inline AI (0–1). Lower = more deterministic, higher = more creative."
              icon="thermometer"
              value={aiConfig.temperature ?? 0.3}
              onChange={(v) => updateAIConfig({ temperature: v })}
              presets={[0.1, 0.3, 0.5, 0.7]}
              min={0}
              max={1}
              step={0.05}
            />

            {/* Context window — auto-detected from models.dev, with manual override */}
            <StepperSettingsRow
              label="Context window"
              description={
                contextAuto && autoState === "detected" && detectedContext
                  ? `Auto: using ${detectedContext.toLocaleString()} tokens detected from models.dev for "${model}". Set a value to override.`
                  : contextAuto && autoState === "not_found"
                    ? `"${model}" isn't in the models.dev catalog, so Auto can't detect its size. Set the context size manually.`
                    : autoState === "detected" && detectedContext
                      ? `Manual override. models.dev reports ${detectedContext.toLocaleString()} tokens for "${model}" — tap Auto to use it.`
                      : "Token limit used to render the chat context ring. Tap Auto to detect it from models.dev, or set a value."
              }
              icon="layers"
              value={aiConfig.contextLimit ?? 128000}
              onChange={(v) => updateAIConfig({ contextLimit: v, contextAuto: false })}
              presets={[8000, 32000, 128000, 200000]}
              min={1000}
              max={2000000}
              step={1000}
              inputWidth="w-28"
              formatPreset={(n) => (n >= 1000 ? `${n / 1000}k` : String(n))}
              autoValue={detectedContext ?? undefined}
              autoState={contextAuto ? autoState : "idle"}
              autoActive={contextAuto}
              onAuto={() =>
                updateAIConfig({
                  contextAuto: true,
                  contextLimit: detectedContext ?? aiConfig.contextLimit ?? 128000,
                })
              }
            />

            {/* Max output tokens — Auto (default) sends no cap so the model
                finishes naturally; a manual value is a deliberate ceiling.
                Capping is what broke "thinking" models (empty reply → 400). */}
            <StepperSettingsRow
              label="Max output tokens"
              description={
                maxOutputAuto
                  ? advertisedMaxOutput
                    ? `Auto: no limit — the model finishes on its own (it supports up to ${advertisedMaxOutput.toLocaleString()} output tokens, per models.dev). Recommended, especially for reasoning models. Set a value only to cap cost.`
                    : "Auto: no limit — the model finishes on its own. Recommended, especially for reasoning models, which need room to think before answering. Set a value only to cap cost per reply."
                  : advertisedMaxOutput
                    ? `Manual cap on a single reply. Reasoning models count their thinking against this, so too low a value can cut them off before they answer. "${model}" supports up to ${advertisedMaxOutput.toLocaleString()} tokens (models.dev). Tap Auto to remove the cap.`
                    : "Manual cap on a single reply's length. Reasoning models count their thinking against this, so too low a value can cut them off before they answer. Tap Auto to remove the cap."
              }
              icon="gauge"
              value={aiConfig.maxOutputTokens ?? 8192}
              onChange={(v) => updateAIConfig({ maxOutputTokens: v, maxOutputAuto: false })}
              presets={[4096, 8192, 16384, 32768, 65536]}
              min={256}
              max={advertisedMaxOutput ?? 384000}
              step={256}
              inputWidth="w-28"
              formatPreset={(n) => (n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : String(n))}
              autoState={maxOutputAuto ? "detected" : "idle"}
              autoActive={maxOutputAuto}
              autoSuppressesValue
              suppressedPlaceholder="No limit"
              onAuto={() => updateAIConfig({ maxOutputAuto: true })}
            />

            {/* Subagents — dispatch → research/write architecture. Cloud only
                (small on-device models are unreliable with the multi-hop split),
                mirroring the chat toolbar's original provider !== "localllm" guard. */}
            <SettingsRow
              label="Subagents"
              description="Route chat through a dispatcher that delegates research and writing to focused sub-agents. Cheaper on long, tool-heavy tasks; adds overhead on quick questions."
            >
              <Toggle
                checked={aiConfig.subagentsEnabled ?? false}
                onChange={(v) => updateAIConfig({ subagentsEnabled: v })}
                label="Enable subagents"
              />
            </SettingsRow>
          </>
        )}
      </SettingsGroup>

      {/* ── MCP Server ── */}
      <MCPServerSettings />

      {browsingProviders && <BrowseProvidersModal onClose={() => setBrowsingProviders(false)} />}
    </div>
  );
}
