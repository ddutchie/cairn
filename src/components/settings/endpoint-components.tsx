"use client";

import React, { useState, useCallback } from "react";
import { Globe, Key, Eye, EyeOff, CheckCircle, Wifi, WifiOff, Wallet } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { storage } from "@/lib/storage";
import { SettingsRow } from "./shared";
import { ModelPicker } from "@/components/ui/model-picker";

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

// ── Per-endpoint model cache ────────────────────────────────────────────────
//
// The model list is cached per endpoint in localStorage so the picker can show
// real models immediately on reopen (no hardcoded fallbacks, no re-fetch). Keyed
// by the normalised base URL + whether a key is present (a key can unlock a
// different catalog on the same host).

const MODEL_CACHE_KEY = "endpoint-models-cache";
/** How long a cached model list is considered fresh (7 days). */
const MODEL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type ModelCache = Record<string, { models: string[]; ts: number }>;

/** Normalise a base URL to a stable cache-key root (drop trailing / and /v1). */
function normBaseUrl(baseUrl: string): string {
  return (baseUrl || "https://api.openai.com").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

function endpointCacheKey(baseUrl: string, apiKey: string): string {
  return `${normBaseUrl(baseUrl)}::${apiKey ? "keyed" : "anon"}`;
}

function readModelCache(baseUrl: string, apiKey: string): string[] | null {
  const all = storage.get<ModelCache>(MODEL_CACHE_KEY);
  const entry = all?.[endpointCacheKey(baseUrl, apiKey)];
  if (!entry) return null;
  if (Date.now() - entry.ts > MODEL_CACHE_TTL_MS) return null; // stale
  return entry.models;
}

function writeModelCache(baseUrl: string, apiKey: string, models: string[]): void {
  const all = storage.get<ModelCache>(MODEL_CACHE_KEY) ?? {};
  all[endpointCacheKey(baseUrl, apiKey)] = { models, ts: Date.now() };
  storage.set(MODEL_CACHE_KEY, all);
}

// ── useEndpointConfig hook ────────────────────────────────────────────────────

/**
 * Remaining-credits / balance info for providers that expose it (e.g.
 * OpenRouter's GET /v1/key). All figures are in USD credits. `null` fields mean
 * "unlimited / not reported"; a `null` KeyInfo means the provider doesn't
 * expose credits at all (so the UI hides the display).
 */
export interface KeyInfo {
  remaining: number | null;
  usage: number | null;
  limit: number | null;
  isFreeTier: boolean | null;
  currency: "USD" | "CNY";
}

export interface EndpointConfigState {
  showKey: boolean;
  testState: TestState;
  testError: string;
  availableModels: string[];
  modelsLoading: boolean;
  /** Provider credits/balance, or null when unavailable. */
  keyInfo: KeyInfo | null;
}

export interface UseEndpointConfigResult extends EndpointConfigState {
  setShowKey: React.Dispatch<React.SetStateAction<boolean>>;
  fetchModels: (baseUrl: string, apiKey: string) => Promise<void>;
  /**
   * Populate `availableModels` for an endpoint without a forced network call:
   * hydrate from the per-endpoint cache if present, else fetch once. Safe to
   * call on open/mount — a no-op when a fresh cache already covers the endpoint.
   */
  ensureModels: (baseUrl: string, apiKey: string) => void;
  /** Best-effort fetch of the provider's remaining credits (null if none). */
  fetchKeyInfo: (baseUrl: string, apiKey: string) => Promise<void>;
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
  const [keyInfo, setKeyInfo] = useState<KeyInfo | null>(null);
  const resetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Advances on every fetch so a slow older request can't overwrite the state of
  // a newer one (endpoint/key changed, or a rapid re-fetch).
  const fetchGenRef = React.useRef(0);
  // Separate generation for the credits lookup, so its own stale-guard can't
  // interfere with (or be clobbered by) fetchModels' generation.
  const keyInfoGenRef = React.useRef(0);

  const fetchKeyInfo = useCallback(async (baseUrl: string, apiKey: string) => {
    // Only available through the main process (needs to resolve the key ref and
    // hit a provider-specific endpoint). No-op / clears on web or when unset.
    if (typeof window === "undefined" || !window.electron?.ai?.fetchKeyInfo) {
      setKeyInfo(null);
      return;
    }
    // Guard against a slow older request overwriting a newer one (endpoint/key
    // changed, or a rapid re-fetch).
    const gen = ++keyInfoGenRef.current;
    const isCurrent = () => gen === keyInfoGenRef.current;
    try {
      const info = await window.electron.ai.fetchKeyInfo({ baseUrl, apiKey });
      if (!isCurrent()) return; // a newer request superseded this one
      setKeyInfo(info ?? null);
    } catch {
      if (!isCurrent()) return;
      setKeyInfo(null); // provider doesn't expose credits — hide silently
    }
  }, []);

  const fetchModels = useCallback(async (baseUrl: string, apiKey: string) => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    const gen = ++fetchGenRef.current;
    const isCurrent = () => gen === fetchGenRef.current;

    setModelsLoading(true);
    setTestState("testing");
    try {
      // Fetch via the main process so the key (a keychain ref) is resolved there
      // and never crosses into the renderer or the CSP boundary. Falls back to a
      // renderer fetch only in the web/no-electron context.
      let ids: string[];
      if (typeof window !== "undefined" && window.electron?.ai?.fetchModels) {
        ids = await window.electron.ai.fetchModels({ baseUrl, apiKey });
      } else {
        const url = normBaseUrl(baseUrl);
        const headers: Record<string, string> = {};
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        // Abort a hung endpoint after 12s (matches the main-process handler).
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 12_000);
        try {
          const res = await fetch(`${url}/v1/models`, { headers, signal: ac.signal });
          if (!res.ok) throw new Error(`${res.status}`);
          const data = await res.json();
          ids = (data?.data ?? [])
            .map((m: { id: string }) => m.id)
            .filter((id: string) => !id.includes("embed") && !id.includes("whisper") && !id.includes("tts") && !id.includes("dall-e"))
            .sort();
        } finally {
          clearTimeout(timer);
        }
      }

      if (!isCurrent()) return; // a newer fetch superseded this one
      setAvailableModels(ids);
      writeModelCache(baseUrl, apiKey, ids); // persist for next open (keyed by endpoint, not the key value)
      setTestState("ok");
      void fetchKeyInfo(baseUrl, apiKey); // refresh credits alongside models
    } catch (err) {
      if (!isCurrent()) return;
      setTestState("error");
      setTestError(err instanceof Error ? err.message : "Failed to fetch models");
      setAvailableModels([]);
    } finally {
      if (isCurrent()) {
        setModelsLoading(false);
        resetTimerRef.current = setTimeout(() => setTestState("idle"), 5000);
      }
    }
  }, [fetchKeyInfo]);

  const ensureModels = useCallback((baseUrl: string, apiKey: string) => {
    const cached = readModelCache(baseUrl, apiKey);
    if (cached && cached.length > 0) {
      setAvailableModels(cached); // instant hydrate from cache — no network
      void fetchKeyInfo(baseUrl, apiKey); // still refresh credits (not cached)
      return;
    }
    void fetchModels(baseUrl, apiKey); // nothing cached → fetch once
  }, [fetchModels, fetchKeyInfo]);

  const resetModels = useCallback(() => {
    // Invalidate any in-flight credits lookup so it can't re-populate keyInfo
    // after we've cleared it (e.g. switching to a provider with no credits).
    keyInfoGenRef.current += 1;
    setAvailableModels([]);
    setKeyInfo(null);
  }, []);

  return { showKey, testState, testError, availableModels, modelsLoading, keyInfo, setShowKey, fetchModels, ensureModels, fetchKeyInfo, resetModels };
}

/** Format a credit amount compactly ($12.34, ¥110, $0.05, $1,234, -$5.00). */
export function formatCredits(n: number, currency: KeyInfo["currency"] = "USD"): string {
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 1 ? 4 : 2;
  const symbol = currency === "CNY" ? "¥" : "$";
  const body = `${symbol}${abs.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: digits })}`;
  return n < 0 ? `-${body}` : body;
}

/**
 * Small inline badge showing a provider's remaining credits (and used, when a
 * finite limit is known). Renders nothing when the provider doesn't expose
 * credits, so it's safe to always mount.
 */
export function CreditsBadge({ info, className }: { info: KeyInfo | null; className?: string }) {
  if (!info) return null;
  const { remaining, usage, limit } = info;
  // Nothing meaningful to show.
  if (remaining == null && usage == null) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[0.714rem] text-[var(--text-tertiary)]",
        className,
      )}
      title={
        limit != null
          ? `Remaining ${formatCredits(remaining ?? Math.max(0, limit - (usage ?? 0)), info.currency)} of ${formatCredits(limit, info.currency)} limit`
          : usage != null
            ? `Used ${formatCredits(usage, info.currency)} so far`
            : undefined
      }
    >
      <Wallet size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
      {remaining != null ? (
        <span>
          <span className="text-[var(--text-secondary)] font-medium">{formatCredits(remaining, info.currency)}</span> credits left
        </span>
      ) : (
        <span>
          <span className="text-[var(--text-secondary)] font-medium">{formatCredits(usage ?? 0, info.currency)}</span> used
        </span>
      )}
    </span>
  );
}

// ── BaseUrlRow ────────────────────────────────────────────────────────────────

export function BaseUrlRow({
  baseUrl,
  onChange,
  description = "Root URL. The chat route appends /v1/chat/completions.",
  showPresets = true,
}: {
  baseUrl: string;
  onChange: (url: string) => void;
  description?: string;
  /** Show the OpenAI/Ollama/LM Studio quick-preset pills. Off where a saved-
   *  providers switcher already covers that role (AISettings cloud path). */
  showPresets?: boolean;
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
        {showPresets && (
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
        )}
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
  /** @deprecated retained for call-site compatibility; the picker labels itself. */
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
          : "Pick a model, refresh the list from your endpoint, or enter a custom one."
      }
    >
      <div className="flex flex-col gap-1.5 items-end w-64">
        <ModelPicker
          value={model}
          options={modelOptions}
          loading={modelsLoading}
          errored={testState === "error"}
          placeholder={placeholder}
          size="md"
          align="end"
          className="w-full"
          onChange={onModelChange}
          onRefresh={onFetch}
        />

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
