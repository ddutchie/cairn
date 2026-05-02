"use client";

import React, { useState } from "react";
import {
  CheckCircle, RefreshCw, Key, Globe, Cpu, Wifi, WifiOff, Eye, EyeOff,
} from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { useCairnStore } from "@/store";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsRow } from "./shared";
import { MCPServerSettings } from "./MCPSettings";

type TestState = "idle" | "testing" | "ok" | "error";

export function AISettings() {
  const { aiConfig, setAIConfig } = useCairnStore();
  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<TestState>("idle");
  const [testError, setTestError] = useState("");

  // Available models fetched from the endpoint
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsFetched, setModelsFetched] = useState(false);

  // Always read directly from the store — no local shadow copy
  const { baseUrl, model, apiKey } = aiConfig;
  const isLocal =
    baseUrl.includes("localhost") ||
    baseUrl.includes("127.0.0.1") ||
    baseUrl.includes("0.0.0.0");

  function update(patch: Partial<typeof aiConfig>) {
    setAIConfig(patch);
    if (patch.baseUrl !== undefined) {
      setAvailableModels([]);
      setModelsFetched(false);
    }
  }

  async function fetchModels() {
    setModelsLoading(true);
    setModelsFetched(true);
    try {
      const url = (baseUrl || "https://api.openai.com").replace(/\/$/, "");
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
      {/* ── Endpoint config ── */}
      <SettingsGroup
        title="AI Endpoint"
        description="Connect to OpenAI, a local Ollama/LM Studio server, or any OpenAI-compatible API. Changes take effect immediately."
      >
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
                onChange={(e) => update({ baseUrl: e.target.value })}
                placeholder="https://api.openai.com"
                className="pl-7 pr-3 py-1.5 text-xs w-64 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
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
                  onClick={() => update({ baseUrl: url })}
                  className={cn(
                    "px-2 py-1 text-[0.714rem] rounded border transition-colors",
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
              onChange={(e) => update({ apiKey: e.target.value })}
              placeholder={isLocal ? "optional" : "sk-…"}
              className="pl-7 pr-8 py-1.5 text-xs w-52 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
            />
            <Tooltip content={showKey ? "Hide API key" : "Show API key"} side="top">
              <button
                onClick={() => setShowKey((s) => !s)}
                aria-label={showKey ? "Hide API key" : "Show API key"}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
              >
                {showKey ? <EyeOff size={11} /> : <Eye size={11} />}
              </button>
            </Tooltip>
          </div>
        </SettingsRow>

        {/* Model + fetch */}
        <SettingsRow
          label="Model"
          description={
            availableModels.length > 0
              ? `${availableModels.length} models loaded from endpoint`
              : "Type a model name or fetch the list from your endpoint."
          }
        >
          <div className="flex flex-col gap-1.5 items-end w-64">
            {/* Text input */}
            <div className="flex gap-1.5 w-full">
              <div className="relative flex-1">
                <Cpu size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                <input
                  type="text"
                  value={model}
                  onChange={(e) => update({ model: e.target.value })}
                  placeholder="gpt-4o-mini"
                  className="pl-7 pr-3 py-1.5 text-xs w-full rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
              <button
                onClick={fetchModels}
                disabled={modelsLoading}
                aria-label="Fetch models from endpoint"
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

            {/* Status line */}
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

            {/* Model chips — scrollable list */}
            <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto w-full pr-0.5">
              {modelOptions.map((m) => (
                <button
                  key={m}
                  onClick={() => update({ model: m })}
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
              {modelsFetched && availableModels.length === 0 && !modelsLoading && testState !== "error" && (
                <span className="text-[0.786rem] text-[var(--text-tertiary)]">No models returned</span>
              )}
            </div>
          </div>
        </SettingsRow>

        {/* Status summary */}
        <div className="flex items-center gap-3 pt-1 text-xs">
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
        </div>
      </SettingsGroup>

      {/* ── MCP Server ── */}
      <MCPServerSettings />
    </div>
  );
}
