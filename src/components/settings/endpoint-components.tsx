"use client";

import React, { useState, useCallback } from "react";
import { Globe, Key, Cpu, RefreshCw, Eye, EyeOff, CheckCircle, Wifi, WifiOff } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SettingsRow } from "./shared";

// ── Constants ─────────────────────────────────────────────────────────────────

export type TestState = "idle" | "testing" | "ok" | "error";

export const BASE_URL_PRESETS = [
  { label: "OpenAI", url: "https://api.openai.com" },
  { label: "Ollama", url: "http://localhost:11434" },
  { label: "LM Studio", url: "http://localhost:1234" },
] as const;

export function isLocalBaseUrl(baseUrl: string): boolean {
  return (
    baseUrl.includes("localhost") ||
    baseUrl.includes("127.0.0.1") ||
    baseUrl.includes("0.0.0.0")
  );
}

export const LOCAL_FALLBACK_MODELS = ["llama3.2", "llama3.1", "qwen2.5:14b", "mistral", "phi4", "gemma3:12b"];

export const CLOUD_FALLBACK_MODELS = ["gpt-4o", "gpt-4-turbo", "gpt-4o-mini", "o1-mini", "o3-mini"];

// ── useEndpointConfig hook ────────────────────────────────────────────────────

export interface EndpointConfigState {
  showKey: boolean;
  testState: TestState;
  testError: string;
  availableModels: string[];
  modelsLoading: boolean;
}

export interface UseEndpointConfigResult extends EndpointConfigState {
  setShowKey: React.Dispatch<React.SetStateAction<boolean>>;
  fetchModels: (baseUrl: string, apiKey: string) => Promise<void>;
  resetModels: () => void;
}

/**
 * Shared state + fetchModels logic for endpoint configuration in AISettings and AgentSettings.
 */
export function useEndpointConfig(): UseEndpointConfigResult {
  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<TestState>("idle");
  const [testError, setTestError] = useState("");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const fetchModels = useCallback(async (baseUrl: string, apiKey: string) => {
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
  }, []);

  const resetModels = useCallback(() => setAvailableModels([]), []);

  return { showKey, testState, testError, availableModels, modelsLoading, setShowKey, fetchModels, resetModels };
}

// ── BaseUrlRow ────────────────────────────────────────────────────────────────

export function BaseUrlRow({
  baseUrl,
  onChange,
  description = "Root URL. The chat route appends /v1/chat/completions.",
}: {
  baseUrl: string;
  onChange: (url: string) => void;
  description?: string;
}) {
  return (
    <SettingsRow label="Base URL" description={description}>
      <div className="flex flex-col gap-1.5 items-end">
        <div className="relative">
          <Globe size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => onChange(e.target.value)}
            placeholder="https://api.openai.com"
            className="pl-7 pr-3 py-1.5 text-xs w-64 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
          />
        </div>
        <div className="flex gap-1.5">
          {BASE_URL_PRESETS.map(({ label, url }) => (
            <button
              key={label}
              onClick={() => onChange(url)}
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
  );
}

// ── ApiKeyRow ─────────────────────────────────────────────────────────────────

export function ApiKeyRow({
  apiKey,
  isLocal,
  showKey,
  onToggleShowKey,
  onChange,
}: {
  apiKey: string;
  isLocal: boolean;
  showKey: boolean;
  onToggleShowKey: () => void;
  onChange: (key: string) => void;
}) {
  return (
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
          onChange={(e) => onChange(e.target.value)}
          placeholder={isLocal ? "optional" : "sk-…"}
          className="pl-7 pr-8 py-1.5 text-xs w-52 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
        />
        <Tooltip content={showKey ? "Hide API key" : "Show API key"} side="top">
          <button
            onClick={onToggleShowKey}
            aria-label={showKey ? "Hide API key" : "Show API key"}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
          >
            {showKey ? <EyeOff size={11} /> : <Eye size={11} />}
          </button>
        </Tooltip>
      </div>
    </SettingsRow>
  );
}

// ── ModelSelectionRow ─────────────────────────────────────────────────────────

export function ModelSelectionRow({
  model,
  modelOptions,
  availableModelsCount,
  modelsLoading,
  testState,
  testError,
  fetchLabel = "Fetch",
  placeholder = "gpt-4o",
  onModelChange,
  onFetch,
}: {
  model: string;
  modelOptions: string[];
  availableModelsCount: number;
  modelsLoading: boolean;
  testState: TestState;
  testError: string;
  fetchLabel?: string;
  placeholder?: string;
  onModelChange: (model: string) => void;
  onFetch: () => void;
}) {
  return (
    <SettingsRow
      label="Model"
      description={
        availableModelsCount > 0
          ? `${availableModelsCount} models loaded from endpoint`
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
              onChange={(e) => onModelChange(e.target.value)}
              placeholder={placeholder}
              className="pl-7 pr-3 py-1.5 text-xs w-full rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
            />
          </div>
          <button
            onClick={onFetch}
            disabled={modelsLoading}
            aria-label={`${fetchLabel} models from endpoint`}
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
        {testState === "ok" && availableModelsCount > 0 && (
          <p className="text-[0.786rem] text-[var(--success)] self-start flex items-center gap-1">
            <CheckCircle size={10} /> {availableModelsCount} models available
          </p>
        )}

        <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto w-full pr-0.5">
          {modelOptions.map((m) => (
            <button
              key={m}
              onClick={() => onModelChange(m)}
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
  );
}

// ── CloudConnectionStatus ─────────────────────────────────────────────────────

export function CloudConnectionStatus({
  testState,
  baseUrl,
  model,
}: {
  testState: TestState;
  baseUrl: string;
  model: string;
}) {
  return (
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
  );
}
