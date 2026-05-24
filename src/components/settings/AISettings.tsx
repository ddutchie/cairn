"use client";

import React, { useState, useEffect } from "react";
import {
  CheckCircle, RefreshCw, Key, Globe, Cpu, Wifi, WifiOff, Eye, EyeOff
} from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsRow, Toggle } from "./shared";
import { MCPServerSettings } from "./MCPSettings";
import type { ToggleableView } from "@/store/slices/ui";

type TestState = "idle" | "testing" | "ok" | "error";

export function AISettings() {
  const { aiConfig, setAIConfig, hiddenViews, toggleViewVisibility } = useCairnStore(useShallow((s) => ({
    aiConfig:             s.aiConfig,
    setAIConfig:          s.setAIConfig,
    hiddenViews:          s.hiddenViews,
    toggleViewVisibility: s.toggleViewVisibility,
  })));

  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<TestState>("idle");
  const [testError, setTestError] = useState("");

  const [appleFMAvailable, setAppleFMAvailable] = useState<boolean | null>(null);
  const [appleFMReason, setAppleFMReason] = useState<string>("");

  useEffect(() => {
    if (typeof window !== "undefined" && window.electron && window.electron.ai && window.electron.ai.appleStatus) {
      window.electron.ai.appleStatus().then((status) => {
        setAppleFMAvailable(status.available);
        if (status.reason) setAppleFMReason(status.reason);
      }).catch((e) => {
        console.error("Failed to check apple-fm status:", e);
        setAppleFMReason(`IPC Error: ${e instanceof Error ? e.message : String(e)}`);
        setAppleFMAvailable(false);
      });
    } else {
      setTimeout(() => {
        const isPreloadMissing = typeof window === "undefined" || !window.electron || !window.electron.ai || !window.electron.ai.appleStatus;
        setAppleFMReason(isPreloadMissing ? "Electron preload API 'ai.appleStatus' is missing. Please rebuild and restart." : "Apple Foundation Models are only supported on macOS.");
        setAppleFMAvailable(false);
      }, 0);
    }
  }, []);

  // Available models fetched from the general endpoint
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  // General config destructuring
  const { provider = "openai", baseUrl, model, apiKey, aiEnabled } = aiConfig;
  const isLocal =
    baseUrl.includes("localhost") ||
    baseUrl.includes("127.0.0.1") ||
    baseUrl.includes("0.0.0.0");

  function updateAIConfig(patch: Partial<typeof aiConfig>) {
    setAIConfig(patch);
    if (patch.baseUrl !== undefined) {
      setAvailableModels([]);
    }
  }

  async function fetchModels() {
    setModelsLoading(true);
    try {
      const url = (baseUrl || "https://api.openai.com").replace(/\/+$/, "").replace(/\/v1$/, "");
      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      const res = await fetch(`${url}/v1/models`, { headers });
      if (!res.ok) throw new Error(`${res.status}`);

      const data = await res.json();
      const ids: string[] = (data?.data ?? [])
        .map((m: { id: string }) => m.id)
        .filter((id: string) => {
          return !id.includes("embed") && !id.includes("whisper") && !id.includes("tts") && !id.includes("dall-e");
        })
        .sort();

      setAvailableModels(ids);
      setTestState("ok");
    } catch (err) {
      setTestState("error");
      setTestError(err instanceof Error ? err.message : "Failed to fetch models");
      setAvailableModels([]);
    } finally {
      setModelsLoading(false);
      setTimeout(() => setTestState("idle"), 5000);
    }
  }

  const fallbackModels = isLocal
    ? ["llama3.2", "llama3.1", "qwen2.5:14b", "mistral", "phi4", "gemma3:12b"]
    : ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "gpt-4", "o1-mini", "o3-mini"];

  const modelOptions = availableModels.length > 0 ? availableModels : fallbackModels;

  return (
    <div className="space-y-8">
      {/* ── Visibility ── */}
      <SettingsGroup
        title="Visibility"
        description="Control which AI features and views are shown."
      >
        <SettingsRow
          label="Enable inline AI"
          description="Shows AI buttons in the editor — text actions, PRD generator, task spawning, and Idea Flow AI summaries. Does not affect the Agent or Chat views."
        >
          <Toggle
            checked={aiEnabled ?? true}
            onChange={(v) => updateAIConfig({ aiEnabled: v })}
          />
        </SettingsRow>
        {([
          { view: "agent" as ToggleableView, label: "Agent view", description: "Embedded coding agent in the sidebar" },
          { view: "chat"  as ToggleableView, label: "AI Chat view", description: "In-app AI chat panel" },
        ]).map(({ view, label, description }) => {
          const visible = !hiddenViews.has(view);
          return (
            <SettingsRow key={view} label={label} description={description}>
              <Toggle checked={visible} onChange={() => toggleViewVisibility(view)} />
            </SettingsRow>
          );
        })}
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
              disabled={!appleFMAvailable}
              onClick={() => updateAIConfig({ provider: "apple-fm" })}
              className={cn(
                "px-3 py-1.5 text-xs rounded-md border transition-all flex items-center gap-2 relative",
                provider === "apple-fm"
                  ? "border-purple-500 text-[var(--text-primary)] bg-[color-mix(in_srgb,var(--purple-500)_12%,transparent)] font-medium"
                  : !appleFMAvailable
                    ? "opacity-50 cursor-not-allowed border-[var(--border)] text-[var(--text-tertiary)]"
                    : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)] cursor-pointer"
              )}
              title={!appleFMAvailable ? (appleFMReason || "Requires Apple Silicon Mac with Apple Intelligence enabled") : " Apple Intelligence"}
            >
              <Cpu size={12} className={provider === "apple-fm" ? "text-purple-500 animate-pulse" : ""} />
               On-Device
              {!appleFMAvailable && (
                <span className="text-[0.625rem] bg-[var(--surface-3)] text-[var(--text-tertiary)] px-1 py-0.5 rounded border border-[var(--border)] font-normal">
                  macOS Only
                </span>
              )}
            </button>
          </div>
        </SettingsRow>

        {provider === "apple-fm" ? (
          <SettingsRow
            label="Apple Intelligence"
            description="On-device Foundation Models configured successfully."
          >
            <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-4 space-y-3 w-full max-w-md text-left">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-purple-500 via-indigo-500 to-cyan-500 flex items-center justify-center text-white font-bold shadow-md">
                  
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-[var(--text-primary)]">On-Device Apple Intelligence</h4>
                  <p className="text-[0.714rem] text-[var(--text-tertiary)]">Powered by macOS Foundation Models</p>
                </div>
              </div>
              <p className="text-[0.786rem] text-[var(--text-secondary)] leading-relaxed">
                Cairn is running private, zero-config on-device inference using your Mac&apos;s built-in language model. 
                All chat history, tasks, and notes remain <strong>100% private and local</strong>, with no API keys, cloud servers, or costs.
              </p>
              <div className="text-[0.714rem] flex items-center gap-2 text-[var(--success)] font-medium bg-[color-mix(in_srgb,var(--success)_10%,transparent)] px-2.5 py-1 rounded-md w-fit">
                <CheckCircle size={12} /> Active &amp; Ready
              </div>
            </div>
          </SettingsRow>
        ) : (
          <>
            {/* Base URL */}
            <SettingsRow
              label="Base URL"
              description="Root URL. The chat route appends /v1/chat/completions."
            >
              <div className="flex flex-col gap-1.5 items-end">
                <div className="relative">
                  <Globe size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                  <input
                    type="url"
                    value={baseUrl}
                    onChange={(e) => updateAIConfig({ baseUrl: e.target.value })}
                    placeholder="https://api.openai.com"
                    className="pl-7 pr-3 py-1.5 text-xs w-64 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-dim)]"
                  />
                </div>
                <div className="flex gap-1.5">
                  {[
                    { label: "OpenAI", url: "https://api.openai.com" },
                    { label: "Ollama", url: "http://localhost:11434" },
                    { label: "LM Studio", url: "http://localhost:1234" },
                  ].map(({ label, url }) => (
                    <button
                      key={label}
                      onClick={() => updateAIConfig({ baseUrl: url })}
                      className={cn(
                        "px-2 py-1 text-[0.714rem] rounded border transition-colors cursor-pointer",
                        baseUrl === url
                          ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                          : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]"
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </SettingsRow>

            {/* API Key */}
            <SettingsRow
              label="API Key"
              description={
                isLocal
                  ? "Local servers don't need a key — leave blank."
                  : "Required for OpenAI. Leave blank to use the OPENAI_API_KEY server env var."
              }
            >
              <div className="relative">
                <Key size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => updateAIConfig({ apiKey: e.target.value })}
                  placeholder={isLocal ? "optional" : "sk-…"}
                  className="pl-7 pr-8 py-1.5 text-xs w-52 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-dim)]"
                />
                <Tooltip content={showKey ? "Hide API key" : "Show API key"} side="top">
                  <button
                    onClick={() => setShowKey((s) => !s)}
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                  >
                    {showKey ? <EyeOff size={11} /> : <Eye size={11} />}
                  </button>
                </Tooltip>
              </div>
            </SettingsRow>

            {/* Model Selection */}
            <SettingsRow
              label="Model"
              description={
                availableModels.length > 0
                  ? `${availableModels.length} models loaded from endpoint`
                  : "Type a model name or fetch the list from your endpoint."
              }
            >
              <div className="flex flex-col gap-1.5 items-end w-64">
                <div className="flex gap-1.5 w-full">
                  <div className="relative flex-1">
                    <Cpu size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                    <input
                      type="text"
                      value={model}
                      onChange={(e) => updateAIConfig({ model: e.target.value })}
                      placeholder="gpt-4o-mini"
                      className="pl-7 pr-3 py-1.5 text-xs w-full rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-dim)]"
                    />
                  </div>
                  <button
                    onClick={fetchModels}
                    disabled={modelsLoading}
                    aria-label="Fetch general models from endpoint"
                    className={cn(
                      "px-2 py-1.5 text-[0.714rem] rounded-md border transition-colors flex items-center gap-1 min-w-[52px] justify-center",
                      "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]",
                      modelsLoading && "opacity-50 cursor-wait"
                    )}
                  >
                    <RefreshCw size={11} className={modelsLoading ? "animate-spin" : ""} />
                    {modelsLoading ? "…" : "Fetch"}
                  </button>
                </div>

                {testState === "error" && (
                  <p className="text-[0.786rem] text-[var(--danger)] self-start" title={testError}>
                    {testError.slice(0, 60)}
                  </p>
                )}
                {testState === "ok" && availableModels.length > 0 && (
                  <p className="text-[0.786rem] text-[var(--success)] self-start flex items-center gap-1">
                    <CheckCircle size={10} /> {availableModels.length} models available
                  </p>
                )}

                <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto w-full pr-0.5">
                  {modelOptions.map((m) => (
                    <button
                      key={m}
                      onClick={() => updateAIConfig({ model: m })}
                      className={cn(
                        "px-2 py-0.5 text-[0.714rem] rounded border transition-colors font-mono whitespace-nowrap",
                        model === m
                          ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                          : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]"
                      )}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            </SettingsRow>
          </>
        )}

        {/* General Connection Status */}
        <div className="flex items-center gap-3 pt-1 text-xs">
          {provider === "apple-fm" ? (
            <>
              <span className="flex items-center gap-1 text-[var(--success)]">
                <CheckCircle size={11} /> Connected (On-Device)
              </span>
              <span className="text-[var(--text-tertiary)]">·</span>
              <span className="text-[var(--text-tertiary)] font-mono"> macOS Foundation Model</span>
            </>
          ) : (
            <>
              <span className={cn(
                "flex items-center gap-1",
                testState === "ok" ? "text-[var(--success)]" : testState === "error" ? "text-[var(--danger)]" : "text-[var(--text-tertiary)]"
              )}>
                {testState === "ok" && <><CheckCircle size={11} /> Connected</>}
                {testState === "error" && <><WifiOff size={11} /> Error</>}
                {(testState === "idle" || testState === "testing") && <><Wifi size={11} /> {testState === "testing" ? "Connecting…" : "Not tested"}</>}
              </span>
              <span className="text-[var(--text-tertiary)]">·</span>
              <span className="text-[var(--text-tertiary)] font-mono truncate max-w-40">{baseUrl.replace(/^https?:\/\//, "")}</span>
              <span className="text-[var(--text-tertiary)]">·</span>
              <span className="text-[var(--text-tertiary)] font-mono">{model || "no model"}</span>
            </>
          )}
        </div>
      </SettingsGroup>

      {/* ── MCP Server ── */}
      <MCPServerSettings />
    </div>
  );
}
