"use client";

import { Globe, Key, Cpu, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Shell, NavRow } from "./shared";

interface Props {
  aiEnabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  onAiEnabledChange: (v: boolean) => void;
  onBaseUrlChange: (v: string) => void;
  onApiKeyChange: (v: string) => void;
  onModelChange: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
}

const ENDPOINT_PRESETS = [
  { label: "OpenAI",    url: "https://api.openai.com" },
  { label: "Ollama",    url: "http://localhost:11434" },
  { label: "LM Studio", url: "http://localhost:1234" },
];

export function StepAISetup({
  aiEnabled, baseUrl, apiKey, model,
  onAiEnabledChange, onBaseUrlChange, onApiKeyChange, onModelChange,
  onBack, onNext,
}: Props) {
  const isLocal =
    baseUrl.includes("localhost") ||
    baseUrl.includes("127.0.0.1") ||
    baseUrl.includes("0.0.0.0");

  const suggestedModels = isLocal
    ? ["llama3.2", "llama3.1", "qwen2.5:14b", "mistral", "phi4", "gemma3:12b"]
    : ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "o1-mini", "o3-mini"];

  return (
    <Shell step="ai-setup">
      <div className="w-full max-w-md flex flex-col gap-4">

        {/* Enable / disable toggle */}
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <Sparkles size={13} className="text-[var(--accent)]" />
              <p className="text-sm font-semibold text-[var(--text-primary)]">Enable AI features</p>
            </div>
            <p className="text-xs text-[var(--text-tertiary)] leading-relaxed">
              Chat with your project, generate PRDs, spawn tasks, and use in-editor text actions.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onAiEnabledChange(!aiEnabled)}
            className={cn(
              "mt-0.5 relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors",
              aiEnabled ? "bg-[var(--accent)]" : "bg-[var(--surface-3)] border border-[var(--border)]"
            )}
            role="switch"
            aria-checked={aiEnabled}
          >
            <span
              className={cn(
                "inline-block h-3.5 w-3.5 rounded-full bg-[var(--surface)] shadow-sm transition-transform",
                aiEnabled ? "translate-x-4.5" : "translate-x-0.5"
              )}
            />
          </button>
        </div>

        {/* Endpoint config — only when enabled */}
        {aiEnabled && (
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5 flex flex-col gap-4">
            <p className="text-xs font-medium text-[var(--text-secondary)]">AI endpoint</p>

            {/* Presets */}
            <div className="flex gap-2">
              {ENDPOINT_PRESETS.map((p) => (
                <button
                  key={p.url}
                  type="button"
                  onClick={() => onBaseUrlChange(p.url)}
                  className={cn(
                    "px-3 py-1.5 text-xs rounded-lg border transition-colors",
                    baseUrl === p.url
                      ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                      : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--accent)]/40 hover:text-[var(--text-secondary)]"
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Base URL */}
            <div className="flex items-center gap-2 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 focus-within:ring-1 focus-within:ring-[var(--accent)]">
              <Globe size={12} className="text-[var(--text-tertiary)] shrink-0" />
              <input
                type="url"
                value={baseUrl}
                onChange={(e) => onBaseUrlChange(e.target.value)}
                placeholder="https://api.openai.com"
                className="flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
              />
            </div>

            {/* API key */}
            {!isLocal ? (
              <div className="flex items-center gap-2 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 focus-within:ring-1 focus-within:ring-[var(--accent)]">
                <Key size={12} className="text-[var(--text-tertiary)] shrink-0" />
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => onApiKeyChange(e.target.value)}
                  placeholder="sk-…  (API key)"
                  className="flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
                />
              </div>
            ) : (
              <p className="text-[0.714rem] text-[var(--text-tertiary)]">
                No API key needed for local endpoints.
              </p>
            )}

            {/* Model */}
            <div>
              <div className="flex items-center gap-2 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 mb-2 focus-within:ring-1 focus-within:ring-[var(--accent)]">
                <Cpu size={12} className="text-[var(--text-tertiary)] shrink-0" />
                <input
                  type="text"
                  value={model}
                  onChange={(e) => onModelChange(e.target.value)}
                  placeholder="Model name"
                  className="flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {suggestedModels.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => onModelChange(m)}
                    className={cn(
                      "px-2 py-0.5 text-[0.714rem] rounded border transition-colors",
                      model === m
                        ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                        : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--accent)]/40 hover:text-[var(--text-secondary)]"
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <NavRow onBack={onBack} onNext={onNext} nextLabel="Continue" />
      </div>
    </Shell>
  );
}
