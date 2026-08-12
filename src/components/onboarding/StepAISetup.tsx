import { useState, useEffect } from "react";
import { Globe, Key, Cpu, Sparkles, CheckCircle, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Shell, NavRow } from "./shared";
import { ProviderGallery } from "./ProviderGallery";
import type { RegistryProviderEntry } from "@/types";

interface Props {
  aiEnabled: boolean;
  provider?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  onAiEnabledChange: (v: boolean) => void;
  onProviderChange: (v: string) => void;
  onBaseUrlChange: (v: string) => void;
  onApiKeyChange: (v: string) => void;
  onModelChange: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
}

export function StepAISetup({
  aiEnabled, provider = "openai", baseUrl, apiKey, model,
  onAiEnabledChange, onProviderChange, onBaseUrlChange, onApiKeyChange, onModelChange,
  onBack, onNext,
}: Props) {
  const [localLLMAvailable, setLocalLLMAvailable] = useState<boolean | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined" && window.electron && window.electron.ai && window.electron.ai.localLLMStatus) {
      window.electron.ai.localLLMStatus().then((status) => {
        setLocalLLMAvailable(status.available);
        if (status.available && (provider === "openai" || !provider)) {
          onProviderChange("localllm");
        }
      }).catch(() => setLocalLLMAvailable(false));
    } else {
      setTimeout(() => setLocalLLMAvailable(false), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isLocal =
    baseUrl.includes("localhost") ||
    baseUrl.includes("127.0.0.1") ||
    baseUrl.includes("0.0.0.0");

  const suggestedModels = isLocal
    ? ["llama3.2", "llama3.1", "qwen2.5:14b", "mistral", "phi4", "gemma3:12b"]
    : ["gpt-5.6-luna", "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o3-mini"];

  /** A gallery provider was installed — make it the ACTIVE connection by
   *  prefilling baseUrl + default model and mirroring its keychain apiKey ref
   *  (the raw key never leaves the keychain). */
  function handleProviderPick({ entry, apiKeyRef }: { entry: RegistryProviderEntry; id: string; apiKeyRef: string }) {
    const def = entry.definition;
    onProviderChange("openai");
    onBaseUrlChange(def.baseUrl);
    if (def.defaultModel) onModelChange(def.defaultModel);
    if (apiKeyRef) onApiKeyChange(apiKeyRef);
  }

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
            
            {/* Provider Switcher Cards */}
            <div className="flex flex-col gap-2.5">
              <p className="text-xs font-semibold text-[var(--text-secondary)]">Select AI Provider</p>
              
              <div className="grid grid-cols-2 gap-3">
                {/* Local Engine */}
                <button
                  type="button"
                  disabled={localLLMAvailable === false}
                  onClick={() => onProviderChange("localllm")}
                  className={cn(
                    "flex flex-col items-center justify-center p-4 rounded-xl border text-center transition-all gap-1.5 relative select-none",
                    provider === "localllm"
                      ? "border-[var(--accent)] bg-[var(--accent-dim)] shadow-sm"
                      : localLLMAvailable === false
                        ? "opacity-50 cursor-not-allowed border-[var(--border)]"
                        : "border-[var(--border)] hover:border-[var(--accent)] hover:bg-[var(--surface-2)] cursor-pointer"
                  )}
                >
                  <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-purple-500 via-indigo-500 to-cyan-500 flex items-center justify-center text-white shadow-sm shrink-0">
                    <Cpu size={14} />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-[var(--text-primary)]">Local Engine</p>
                    <p className="text-[0.625rem] text-[var(--text-tertiary)] mt-0.5">On-Device Llama</p>
                  </div>
                  {localLLMAvailable === false && (
                    <span className="absolute top-1.5 right-1.5 text-[0.55rem] bg-[var(--surface-3)] text-[var(--text-tertiary)] px-1 py-0.2 rounded border border-[var(--border)] font-normal">
                      Desktop Only
                    </span>
                  )}
                </button>

                {/* Cloud/Local API */}
                <button
                  type="button"
                  onClick={() => onProviderChange("openai")}
                  className={cn(
                    "flex flex-col items-center justify-center p-4 rounded-xl border text-center transition-all gap-1.5 select-none cursor-pointer",
                    provider === "openai"
                      ? "border-[var(--accent)] bg-[var(--accent-dim)] shadow-sm"
                      : "border-[var(--border)] hover:border-[var(--accent)] hover:bg-[var(--surface-2)]"
                  )}
                >
                  <div className="w-8 h-8 rounded-full bg-[var(--surface-2)] border border-[var(--border)] flex items-center justify-center text-[var(--text-secondary)] shadow-sm shrink-0">
                    <Globe size={13} />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-[var(--text-primary)]">Cloud &amp; Local</p>
                    <p className="text-[0.625rem] text-[var(--text-tertiary)] mt-0.5">OpenAI, Ollama, LM Studio</p>
                  </div>
                </button>
              </div>
            </div>

            {provider === "localllm" ? (
              <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-xl p-4 text-xs space-y-2 text-left leading-relaxed">
                <p className="font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                  <CheckCircle size={12} className="text-[var(--success)]" /> Ready for Offline Use
                </p>
                <p className="text-[var(--text-secondary)]">
                  You&apos;ve selected the native Local LLM Engine. All interactions are processed privately on your hardware using on-device models via Llama.cpp, with zero network calls, server requirements, or API costs.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <div>
                  <p className="text-xs font-medium text-[var(--text-secondary)] mb-2">Add an AI provider</p>
                  <p className="text-xs text-[var(--text-tertiary)] leading-relaxed mb-3">
                    Pick a preset — it&apos;s added to your saved providers and becomes the active connection.
                    Keys are stored in your OS keychain.
                  </p>
                  <ProviderGallery onPick={handleProviderPick} />
                </div>

                {/* Advanced — manual endpoint config */}
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="flex items-center gap-1.5 text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
                >
                  <SlidersHorizontal size={11} />
                  {showAdvanced ? "Hide manual endpoint" : "Manual endpoint / custom model"}
                </button>

                {showAdvanced && (
                  <div className="flex flex-col gap-4">
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
                              "px-2 py-0.5 text-[0.714rem] rounded border transition-colors cursor-pointer",
                              model === m
                                ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                                : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[color-mix(in_srgb,var(--accent)_40%,transparent)] hover:text-[var(--text-secondary)]"
                            )}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <NavRow onBack={onBack} onNext={onNext} nextLabel="Continue" />
      </div>
    </Shell>
  );
}
