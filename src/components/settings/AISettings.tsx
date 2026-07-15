"use client";

import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { Cpu, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsRow, Toggle, StepperSettingsRow } from "./shared";
import {
  BaseUrlRow, ApiKeyRow, ModelSelectionRow, CloudConnectionStatus,
  useEndpointConfig, isLocalBaseUrl, LOCAL_FALLBACK_MODELS,
} from "./endpoint-components";
import { MCPServerSettings } from "./MCPSettings";
import { LlamaServerConsole } from "./LlamaServerConsole";

export function AISettings() {
  const { aiConfig, setAIConfig } = useCairnStore(useShallow((s) => ({
    aiConfig:             s.aiConfig,
    setAIConfig:          s.setAIConfig,
  })));

  const {
    showKey, testState, testError, availableModels, modelsLoading,
    setShowKey, fetchModels, resetModels,
  } = useEndpointConfig();

  // General config destructuring
  const { provider = "openai", baseUrl, model, apiKey, aiEnabled } = aiConfig;
  const isLocal = isLocalBaseUrl(baseUrl);

  function updateAIConfig(patch: Partial<typeof aiConfig>) {
    setAIConfig(patch);
    if (patch.baseUrl !== undefined || patch.apiKey !== undefined) {
      resetModels();
    }
  }

  const fallbackModels = isLocal
    ? LOCAL_FALLBACK_MODELS
    : ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "gpt-4", "o1-mini", "o3-mini"];

  const modelOptions = availableModels.length > 0 ? availableModels : fallbackModels;

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
          description="Choose between local on-device Apple Intelligence or standard cloud/local API connections."
        >
          <div className="flex gap-2">
            <button
              onClick={() => updateAIConfig({ provider: "openai" })}
              className={cn(
                "px-3 py-1.5 text-xs rounded-md border transition-all flex items-center gap-2 cursor-pointer",
                provider === "openai"
                  ? "border-[var(--accent)] text-[var(--text-primary)] bg-[var(--accent-dim)] font-medium"
                  : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]"
              )}
            >
              <Globe size={12} />
              Cloud / Local API
            </button>
            <button
              onClick={() => updateAIConfig({ provider: "localllm" })}
              className={cn(
                "px-3 py-1.5 text-xs rounded-md border transition-all flex items-center gap-2 relative cursor-pointer",
                provider === "localllm"
                  ? "border-[var(--accent)] text-[var(--text-primary)] bg-[var(--accent-dim)] font-medium"
                  : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]"
              )}
            >
              <Cpu size={12} className={provider === "localllm" ? "text-[var(--accent)] animate-pulse" : ""} />
              On-Device Llama
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
            <BaseUrlRow baseUrl={baseUrl} onChange={(url) => updateAIConfig({ baseUrl: url })} />
            <ApiKeyRow
              apiKey={apiKey}
              isLocal={isLocal}
              showKey={showKey}
              onToggleShowKey={() => setShowKey((s) => !s)}
              onChange={(key) => updateAIConfig({ apiKey: key })}
            />
            <ModelSelectionRow
              model={model}
              modelOptions={modelOptions}
              availableModelsCount={availableModels.length}
              modelsLoading={modelsLoading}
              testState={testState}
              testError={testError}
              placeholder="gpt-4o-mini"
              onModelChange={(m) => updateAIConfig({ model: m })}
              onFetch={() => fetchModels(baseUrl, apiKey)}
            />

            {/* Max Steps — applies to all providers */}
            {maxStepsRow}

            {/* Cloud connection status */}
            <div className="flex items-center gap-3 pt-1 text-xs">
              <CloudConnectionStatus testState={testState} baseUrl={baseUrl} model={model} />
            </div>
          </>
        )}
      </SettingsGroup>

      {/* ── MCP Server ── */}
      <MCPServerSettings />
    </div>
  );
}
