"use client";

import { useState, useEffect, useSyncExternalStore } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { Plus, Pencil, Trash2, Check, X, Server, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { persist } from "@/lib/ipc/client";
import { secretsClient } from "@/lib/ipc/tools";
import type { SavedProvider, ApiMode } from "@/store/slices/ui";
import { dedupeProviders } from "@/store/slices/ui";
import { SettingsRow } from "./shared";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown";
import { Select } from "@/components/ui/select";
import { ModelPicker } from "@/components/ui/model-picker";
import { useEndpointConfig, CreditsBadge } from "./endpoint-components";
import { ConnectorLogo } from "./tools/ConnectorLogo";
import { endpointLogoSlug } from "../../../shared/models/model-catalog";
import {
  getOrFetchLogoSvg,
  subscribeModelCatalog,
  getModelCatalogVersion,
  endpointProtocolFor,
} from "@/lib/models-dev";
import { opencodeSlugForBaseUrl, type WireProtocol } from "../../../shared/models/model-catalog";
import type { ProbeProtocol, ProtocolAvailability } from "../../../shared/chat/protocol-probe";
import { Tooltip } from "@/components/ui/tooltip";

const PROTOCOL_LABEL: Record<WireProtocol, string> = {
  completions: "Chat Completions",
  responses: "Responses",
  "anthropic-messages": "Anthropic Messages",
  google: "Gemini",
};

const AVAILABILITY_TAG: Record<ProtocolAvailability, string | null> = {
  available: "available",
  unsupported: "not for this model",
  missing: "not offered",
  auth: null,
  unknown: null,
};

/**
 * Which wire protocols the endpoint offers for `model`, probed in main (stored
 * key resolved there) once base URL and model are set, debounced while typing.
 * null until a probe has answered for the current inputs.
 */
function useProtocolAvailability(baseUrl: string, apiKey: string, model: string, enabled: boolean) {
  const [result, setResult] = useState<{ key: string; value: Record<ProbeProtocol, ProtocolAvailability> } | null>(null);
  const [probing, setProbing] = useState(false);
  const key = `${baseUrl.trim()}|${model.trim()}|${apiKey}`;
  useEffect(() => {
    const probe = window.electron?.ai?.probeProtocols;
    if (!enabled || !baseUrl.trim() || !model.trim() || !probe) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setProbing(true);
      try {
        const value = await probe({ baseUrl: baseUrl.trim(), apiKey, model: model.trim() });
        if (!cancelled) setResult({ key, value });
      } catch {
        // Best-effort: the picker just shows no availability tags.
      } finally {
        if (!cancelled) setProbing(false);
      }
    }, 800);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return { availability: result?.key === key ? result.value : null, probing };
}

/** Normalize an endpoint URL for keyed matching (trailing slash + case). */
function normBaseUrl(url: string): string {
  return (url ?? "").trim().toLowerCase().replace(/\/+$/, "");
}

// A stable empty array so the selector never returns a fresh reference (which
// would break useShallow's snapshot caching and spin an infinite render loop).
const EMPTY_PROVIDERS: SavedProvider[] = [];

/**
 * Saved cloud/local API providers switcher. The provider LIST is a single
 * shared source of truth (stored on aiConfig.savedProviders) used by both the
 * AI Chat and the coding agent; each keeps its own active selection. Lets the
 * user switch the active one, or add/edit/delete entries. Selecting a provider
 * mirrors its connection into the relevant config so the rest of the app picks
 * it up unchanged.
 *
 * `kind` selects which config's ACTIVE provider this instance controls:
 *   - "ai"    → the AI Chat / inline-AI cloud provider (aiConfig)
 *   - "agent" → the coding agent's provider (agentConfig)
 */
export function ProviderManager({ kind = "ai" }: { kind?: "ai" | "agent" }) {
  const {
    savedProviders, activeProviderId, activeModel,
    addSavedProvider, updateSavedProvider, deleteSavedProvider, selectProvider,
    setAgentConfig, setAIConfig,
  } = useCairnStore(useShallow((s) => ({
    // The list is always shared — read it from aiConfig.
    savedProviders:      s.aiConfig.savedProviders,
    // Active id + the surface's chosen model depend on which config this drives.
    activeProviderId:    kind === "agent" ? s.agentConfig.activeProviderId : s.aiConfig.activeProviderId,
    activeModel:         kind === "agent" ? s.agentConfig.model : s.aiConfig.model,
    addSavedProvider:    s.addSavedProvider,
    updateSavedProvider: s.updateSavedProvider,
    deleteSavedProvider: s.deleteSavedProvider,
    selectProvider:      kind === "agent" ? s.selectAgentProvider : s.selectSavedProvider,
    // Select the STABLE store actions — never build new closures inside the
    // selector, or useShallow's snapshot never caches and we spin an infinite
    // render loop.
    setAgentConfig:      s.setAgentConfig,
    setAIConfig:         s.setAIConfig,
  })));

  // Model is a PER-SURFACE choice on the config, not the shared provider.
  // Build the wrapper OUTSIDE the selector against the stable actions above.
  const setModel = kind === "agent"
    ? (model: string) => setAgentConfig({ model })
    : (model: string) => setAIConfig({ model });

  // Defensive de-dup by id: guarantees unique React keys in the list below even
  // if a corrupted/doubled list is still in memory before hydration self-heals.
  const providers = dedupeProviders(savedProviders ?? EMPTY_PROVIDERS);
  const active = providers.find((p) => p.id === activeProviderId);

  // Re-render when lazily-fetched models.dev provider SVGs land (the saved-
  // provider rows fall back to a generic glyph and pop in once the logo SVG is
  // cached). The version bumps once per arrival; cheap.
  useSyncExternalStore(subscribeModelCatalog, getModelCatalogVersion);

  // null = form closed; "new" = adding; otherwise the id being edited.
  const [editing, setEditing] = useState<null | "new" | string>(null);
  const formOpen = editing !== null;

  const editingProvider = typeof editing === "string" && editing !== "new"
    ? providers.find((p) => p.id === editing)
    : undefined;

  // Community-provider brand logos keyed by communityId AND normalized
  // baseUrl, fetched once (cache-first) so saved community providers show
  // their real brand mark instead of the generic Server icon. The baseUrl key
  // also covers providers added manually (before they existed in the registry)
  // that happen to share an endpoint with a catalog entry. Manual providers
  // with a unique baseUrl fall back to Server.
  const [logoMap, setLogoMap] = useState<Record<string, { iconSvg?: string; brandColor?: string }>>({});
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const reg = window.electron?.registry;
      if (!reg?.fetchProviders) return;
      try {
        const { manifest } = await reg.fetchProviders();
        if (cancelled || !manifest) return;
        const map: Record<string, { iconSvg?: string; brandColor?: string }> = {};
        for (const e of manifest.providers) {
          map[e.id] = { iconSvg: e.iconSvg, brandColor: e.brandColor };
          if (e.definition.baseUrl) map[normBaseUrl(e.definition.baseUrl)] = { iconSvg: e.iconSvg, brandColor: e.brandColor };
        }
        setLogoMap(map);
      } catch {
        // offline / no registry — rows fall back to the generic Server icon
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /** Brand-mark props for a saved provider — inline iconSvg from the community
   *  catalog, or inline SVG fetched from models.dev for a direct-vendor
   *  hostname. When the models.dev SVG hasn't loaded yet the row falls back to
   *  the generic glyph and re-renders once it arrives (the version subscription
   *  below powers that re-render). */
  const logoPropsFor = (p: SavedProvider): { iconSvg: string; brandColor?: string } | null => {
    const comm = (p.communityId ? logoMap[p.communityId] : undefined) ?? logoMap[normBaseUrl(p.baseUrl)];
    if (comm?.iconSvg) return { iconSvg: comm.iconSvg, brandColor: comm.brandColor };
    // Fall back to the direct vendor's models.dev logo when the community
    // catalog has no inline iconSvg for this hostname (e.g. openai/together/
    // groq/fireworks/neuralwatt) — renders on the SAME light chip as community
    // icons. Returns null + kicks off the fetch; re-renders on arrival.
    const slug = endpointLogoSlug(p.baseUrl);
    if (slug) {
      const svg = getOrFetchLogoSvg(slug);
      if (svg) return { iconSvg: svg };
    }
    return null;
  };

  return (
    <>
      <SettingsRow
        label="Provider"
        description={kind === "agent"
          ? "Which saved provider the coding agent uses. Saved providers are shared with Chat; add or edit them here."
          : "Which saved provider Chat uses. Saved providers are shared with the coding agent; add or edit them here."}
      >
        <div className="flex flex-col gap-1.5 items-end w-64">
          <div className="flex gap-1.5 w-full">
            <DropdownMenu>
              <Tooltip content="Finish or cancel the open provider form first" disabled={!formOpen}>
                <DropdownMenuTrigger asChild disabled={providers.length === 0 || formOpen}>
                  <button
                    disabled={formOpen}
                    className={cn(
                      "flex-1 flex items-center justify-between gap-2 pl-2.5 pr-2 py-1.5 text-xs rounded-md",
                      "bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)]",
                      "hover:border-[var(--muted)] focus:outline-none focus:border-[var(--accent)] transition-colors cursor-pointer",
                      (providers.length === 0 || formOpen) && "opacity-50 cursor-not-allowed",
                    )}
                  >
                    <span className="flex items-center gap-1.5 min-w-0">
                      {active ? (
                        (() => {
                          const lp = logoPropsFor(active);
                          return lp ? (
                            <ConnectorLogo iconSvg={lp.iconSvg} kind="service" color={lp.brandColor} size={12} />
                          ) : (
                            <Server size={12} className="text-[var(--text-tertiary)] flex-shrink-0" />
                          );
                        })()
                      ) : (
                        <Server size={12} className="text-[var(--text-tertiary)] flex-shrink-0" />
                      )}
                      <span className="truncate">
                        {active ? active.name : "No saved providers"}
                      </span>
                    </span>
                    <ChevronDown size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
                  </button>
                </DropdownMenuTrigger>
              </Tooltip>
              <DropdownMenuContent align="start" className="w-[220px] max-h-64 overflow-y-auto">
                {providers.map((p) => (
                  <DropdownMenuItem
                    key={p.id}
                    onSelect={() => selectProvider(p.id)}
                    className={cn("text-xs", p.id === activeProviderId && "text-[var(--accent)]")}
                  >
                    <span className="w-3.5 flex-shrink-0 flex items-center justify-center">
                      {p.id === activeProviderId ? (
                        <Check size={12} />
                      ) : (() => {
                        const lp = logoPropsFor(p);
                        return lp ? (
                          <ConnectorLogo iconSvg={lp.iconSvg} kind="service" color={lp.brandColor} size={12} />
                        ) : null;
                      })()}
                    </span>
                    <span className="flex flex-col min-w-0">
                      <span className="truncate">{p.name}</span>
                      <span className="truncate text-xs text-[var(--text-tertiary)] font-mono">
                        {p.id === activeProviderId ? (activeModel || p.model) : p.model}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip content={formOpen ? "Finish or cancel the open provider form first" : "Add a provider"}>
              <button
                onClick={() => setEditing("new")}
                disabled={formOpen}
                aria-label="Add provider"
                className={cn(
                  "px-2 py-1.5 text-xs rounded-md border border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)] transition-colors flex items-center gap-1 cursor-pointer",
                  formOpen && "opacity-50 cursor-not-allowed hover:border-[var(--border)] hover:text-[var(--text-tertiary)]",
                )}
              >
                <Plus size={11} /> Add
              </button>
            </Tooltip>
          </div>

          {active && !formOpen && (
            <div className="flex gap-1.5">
              <button
                onClick={() => setEditing(active.id)}
                className="px-2 py-1 text-xs rounded border border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)] transition-colors flex items-center gap-1 cursor-pointer"
              >
                <Pencil size={10} /> Edit
              </button>
              <button
                onClick={() => {
                  persist(secretsClient.delete("llm", active.id, "apiKey"), "Couldn't remove the API key");
                  deleteSavedProvider(active.id);
                }}
                className="px-2 py-1 text-xs rounded border border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--danger)] hover:text-[var(--danger)] transition-colors flex items-center gap-1 cursor-pointer"
              >
                <Trash2 size={10} /> Delete
              </button>
            </div>
          )}
        </div>
      </SettingsRow>

      {/* Quick model switch for THIS surface's active provider — writes to the
          config (aiConfig/agentConfig), not the shared provider, so chat and the
          agent can run different models on the same connection. */}
      {active && !formOpen && (
        <ActiveModelRow
          key={active.id}
          provider={active}
          model={activeModel || active.model}
          onModelChange={setModel}
        />
      )}

      {editing && (
        <ProviderForm
          key={editing}
          initial={editingProvider}
          defaultModel="gpt-5.6-luna"
          onCancel={() => setEditing(null)}
          onSave={async ({ name, baseUrl, model, rawKey, keyDirty, apiMode }) => {
            if (editing === "new") {
              // Create first (no key), then store the raw key in the OS keychain
              // and save the returned reference token — the raw key never lands
              // in the store, localStorage, or the settings cache.
              const id = addSavedProvider({ name, baseUrl, model, apiKey: "", apiMode }, kind);
              if (keyDirty && rawKey) {
                try {
                  const ref = await window.electron?.secrets?.set("llm", id, "apiKey", rawKey);
                  updateSavedProvider(id, { apiKey: ref ?? "" });
                } catch (e) {
                  // Don't leave an orphaned empty-key provider on keychain failure.
                  deleteSavedProvider(id);
                  throw e;
                }
              }
            } else {
              const patch: { name: string; baseUrl: string; model: string; apiKey?: string; apiMode: ApiMode } = { name, baseUrl, model, apiMode };
              if (keyDirty) {
                if (rawKey) {
                  const ref = await window.electron?.secrets?.set("llm", editing, "apiKey", rawKey);
                  patch.apiKey = ref ?? "";
                } else {
                  await window.electron?.secrets?.delete("llm", editing, "apiKey");
                  patch.apiKey = "";
                }
              }
              updateSavedProvider(editing, patch);
            }
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function ProviderForm({
  initial,
  defaultModel,
  onSave,
  onCancel,
}: {
  initial?: SavedProvider;
  defaultModel: string;
  onSave: (data: { name: string; baseUrl: string; model: string; rawKey: string; keyDirty: boolean; apiMode: ApiMode }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "https://api.openai.com");
  const [model, setModel] = useState(initial?.model ?? defaultModel);
  // Explicit wire protocol for this endpoint (Cairn never auto-probes). Default
  // "completions" — the universally-supported chat-completions surface.
  const [apiMode, setApiMode] = useState<ApiMode>(initial?.apiMode ?? "completions");
  // The stored key is a keychain reference, never shown. `keyInput` holds only a
  // newly-typed raw key; `keyDirty` marks that the user changed it.
  const [keyInput, setKeyInput] = useState("");
  const [keyDirty, setKeyDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Whether this provider already has a key stored (drives the placeholder).
  const hadKey = !!(initial?.apiKey && initial.apiKey.startsWith("secret://"));

  // Fetch this provider's own model list so the picker can offer real options +
  // Refresh. Hydrate from cache (or fetch once) on open — no hardcoded
  // fallbacks. The key passed is the stored ref (resolved in main) or, once the
  // user types a new one, the raw key.
  const { availableModels, fetchModels, ensureModels, resetModels, modelsLoading, testState, keyInfo } = useEndpointConfig();
  const keyForFetch = keyDirty ? keyInput : (initial?.apiKey ?? "");
  useEffect(() => {
    ensureModels(baseUrl, keyForFetch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canSave = name.trim().length > 0 && baseUrl.trim().length > 0 && !saving;

  // OpenCode serves each model over one protocol and main mounts that one
  // whatever apiMode says (wireApiFor), so the picker shows the per-model choice
  // instead of a setting that has no effect. Re-read when models.dev lands.
  useSyncExternalStore(subscribeModelCatalog, getModelCatalogVersion);
  const perModelEndpoint = opencodeSlugForBaseUrl(baseUrl) !== null;
  const dictated = perModelEndpoint ? endpointProtocolFor(baseUrl, model) : null;
  const { availability, probing } = useProtocolAvailability(baseUrl, keyForFetch, model, !perModelEndpoint);
  const tagFor = (p: ProbeProtocol) => (availability ? AVAILABILITY_TAG[availability[p]] : null);
  const selectedOffline = availability && availability[apiMode] !== "available" && availability[apiMode] !== "unknown" && availability[apiMode] !== "auth";
  const better = selectedOffline
    ? (["completions", "responses", "anthropic-messages"] as const).find((p) => availability?.[p] === "available")
    : undefined;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({ name: name.trim(), baseUrl: baseUrl.trim(), model: model.trim(), rawKey: keyInput.trim(), keyDirty, apiMode });
      // onSave closes the form on success.
    } catch (e) {
      // Keychain (or persistence) failure — keep the form open so the user can
      // retry; the caller has already cleaned up any half-created provider.
      setSaveError(e instanceof Error ? e.message : "Couldn't save the provider — please try again.");
      setSaving(false);
    }
  }

  const inputCls = "px-2.5 py-1.5 text-xs w-full rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]";

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface-1)] p-3 space-y-2.5">
      <div className="text-xs font-medium text-[var(--text-secondary)]">
        {initial ? "Edit provider" : "New provider"}
      </div>
      <div className="grid grid-cols-1 @sm:grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--text-tertiary)]">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="OpenAI" className={inputCls} />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-[var(--text-tertiary)]">Default model</span>
          <ModelPicker
            value={model}
            options={availableModels}
            loading={modelsLoading}
            errored={testState === "error"}
            placeholder={defaultModel}
            size="md"
            onChange={setModel}
            onRefresh={() => fetchModels(baseUrl, keyForFetch)}
          />
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--text-tertiary)]">Base URL</span>
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => { setBaseUrl(e.target.value); resetModels(); }}
            placeholder="https://api.openai.com"
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--text-tertiary)]">API Key</span>
          <input
            type="password"
            value={keyInput}
            onChange={(e) => { setKeyInput(e.target.value); setKeyDirty(true); resetModels(); }}
            placeholder={hadKey ? "•••••••• stored — type to replace" : "sk-… (optional for local)"}
            className={inputCls}
          />
          <span className="text-2xs text-[var(--text-tertiary)]">Stored in your OS keychain, never synced.</span>
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-[var(--text-tertiary)]">API protocol</span>
          {perModelEndpoint ? (
            <>
              <div className="px-2.5 py-1.5 text-xs w-full rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)]">
                Automatic — {dictated ? PROTOCOL_LABEL[dictated] : "picked per model"}
              </div>
              <span className="text-2xs text-[var(--text-tertiary)]">
                OpenCode serves each model over one API, so Cairn picks it per model{dictated && model.trim() ? ` (${model.trim()} uses ${PROTOCOL_LABEL[dictated]})` : ""}.
              </span>
            </>
          ) : (
            <>
              <Select<ApiMode>
                value={apiMode}
                onChange={setApiMode}
                size="md"
                ariaLabel="API protocol"
                className="w-full"
                options={([
                  ["completions", "Chat Completions (/v1/chat/completions)"],
                  ["responses", "Responses (/v1/responses)"],
                  ["anthropic-messages", "Anthropic Messages (/v1/messages)"],
                ] as const).map(([value, label]) => ({
                  value,
                  label: (
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate">{label}</span>
                      {tagFor(value) && (
                        <span className={cn("shrink-0 text-2xs", availability?.[value] === "available" ? "text-[var(--success)]" : "text-[var(--text-tertiary)]")}>
                          {tagFor(value)}
                        </span>
                      )}
                    </span>
                  ),
                }))}
              />
              <span className="text-2xs text-[var(--text-tertiary)]">
                {probing
                  ? "Checking which APIs this endpoint offers…"
                  : availability?.[apiMode] === "auth"
                    ? "Couldn't check the APIs — the endpoint refused the key."
                    : better
                      ? (
                        <>
                          {model.trim()} isn&apos;t available over {PROTOCOL_LABEL[apiMode]} here.{" "}
                          <button type="button" onClick={() => setApiMode(better)} className="text-[var(--accent)] hover:underline cursor-pointer">
                            Use {PROTOCOL_LABEL[better]}
                          </button>
                        </>
                      )
                      : "Wire protocol this endpoint speaks. Pinned per provider; checked against the model above."}
              </span>
            </>
          )}
        </div>
      </div>
      {keyInfo && (
        <div className="flex items-center gap-1.5">
          <CreditsBadge info={keyInfo} />
        </div>
      )}
      {saveError && (
        <p className="text-xs text-[var(--danger)]">{saveError}</p>
      )}
      <div className="flex justify-end gap-1.5 pt-0.5">
        <button
          onClick={onCancel}
          className="px-2.5 py-1 text-xs rounded border border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors flex items-center gap-1 cursor-pointer"
        >
          <X size={11} /> Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!canSave}
          className={cn(
            "px-2.5 py-1 text-xs rounded border transition-colors flex items-center gap-1",
            canSave
              ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)] hover:bg-[var(--accent-dim)] cursor-pointer"
              : "border-[var(--border)] text-[var(--text-tertiary)] opacity-50 cursor-not-allowed",
          )}
        >
          <Check size={11} /> {saving ? "Saving…" : initial ? "Save" : "Add"}
        </button>
      </div>
    </div>
  );
}

/**
 * A standalone "Model" settings row for the currently-active provider, so the
 * model can be changed without opening the full Add/Edit form. Fetches the
 * provider's model list (cache-first, via the main-process IPC that resolves the
 * key ref) and writes the chosen model to THIS surface's config — the coding
 * agent and chat keep independent models on the same shared provider.
 */
function ActiveModelRow({
  provider,
  model,
  onModelChange,
}: {
  provider: SavedProvider;
  model: string;
  onModelChange: (model: string) => void;
}) {
  const { availableModels, fetchModels, ensureModels, modelsLoading, testState, keyInfo } = useEndpointConfig();
  useEffect(() => {
    ensureModels(provider.baseUrl, provider.apiKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id]);

  return (
    <SettingsRow label="Model" description="Model for the active provider. Chat and the coding agent keep separate models on the same provider.">
      <div className="flex flex-col gap-1.5 items-end w-64">
        <ModelPicker
          value={model}
          options={availableModels}
          loading={modelsLoading}
          errored={testState === "error"}
          placeholder={provider.model || "gpt-5.6-luna"}
          size="md"
          align="end"
          className="w-full"
          onChange={onModelChange}
          onRefresh={() => fetchModels(provider.baseUrl, provider.apiKey)}
        />
        <CreditsBadge info={keyInfo} />
      </div>
    </SettingsRow>
  );
}
