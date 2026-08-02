"use client";

import { useState, useEffect } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { Plus, Pencil, Trash2, Check, X, Server, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SavedProvider } from "@/store/slices/ui";
import { dedupeProviders } from "@/store/slices/ui";
import { SettingsRow } from "./shared";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown";
import { ModelPicker } from "@/components/ui/model-picker";
import { useEndpointConfig, CreditsBadge } from "./endpoint-components";

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

  // null = form closed; "new" = adding; otherwise the id being edited.
  const [editing, setEditing] = useState<null | "new" | string>(null);
  const formOpen = editing !== null;

  const editingProvider = typeof editing === "string" && editing !== "new"
    ? providers.find((p) => p.id === editing)
    : undefined;

  return (
    <>
      <SettingsRow
        label="Saved providers"
        description="Save named OpenAI-compatible connections (endpoint, key, model) and switch between them. Shared with the coding agent — each picks its own active provider. The active one fills the fields below."
      >
        <div className="flex flex-col gap-1.5 items-end w-64">
          <div className="flex gap-1.5 w-full">
            <DropdownMenu>
              <DropdownMenuTrigger asChild disabled={providers.length === 0 || formOpen}>
                <button
                  disabled={formOpen}
                  title={formOpen ? "Finish or cancel the open provider form first" : undefined}
                  className={cn(
                    "flex-1 flex items-center justify-between gap-2 pl-2.5 pr-2 py-1.5 text-xs rounded-md",
                    "bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)]",
                    "hover:border-[var(--muted)] focus:outline-none focus:border-[var(--accent)] transition-colors cursor-pointer",
                    (providers.length === 0 || formOpen) && "opacity-50 cursor-not-allowed",
                  )}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <Server size={12} className="text-[var(--text-tertiary)] flex-shrink-0" />
                    <span className="truncate">
                      {active ? active.name : "No saved providers"}
                    </span>
                  </span>
                  <ChevronDown size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[220px] max-h-64 overflow-y-auto">
                {providers.map((p) => (
                  <DropdownMenuItem
                    key={p.id}
                    onSelect={() => selectProvider(p.id)}
                    className={cn("text-xs", p.id === activeProviderId && "text-[var(--accent)]")}
                  >
                    <span className="w-3.5 flex-shrink-0">
                      {p.id === activeProviderId && <Check size={12} />}
                    </span>
                    <span className="flex flex-col min-w-0">
                      <span className="truncate">{p.name}</span>
                      <span className="truncate text-[0.714rem] text-[var(--text-tertiary)] font-mono">
                        {p.id === activeProviderId ? (activeModel || p.model) : p.model}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              onClick={() => setEditing("new")}
              disabled={formOpen}
              aria-label="Add provider"
              title={formOpen ? "Finish or cancel the open provider form first" : "Add a provider"}
              className={cn(
                "px-2 py-1.5 text-[0.714rem] rounded-md border border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)] transition-colors flex items-center gap-1 cursor-pointer",
                formOpen && "opacity-50 cursor-not-allowed hover:border-[var(--border)] hover:text-[var(--text-tertiary)]",
              )}
            >
              <Plus size={11} /> Add
            </button>
          </div>

          {active && !formOpen && (
            <div className="flex gap-1.5">
              <button
                onClick={() => setEditing(active.id)}
                className="px-2 py-1 text-[0.714rem] rounded border border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)] transition-colors flex items-center gap-1 cursor-pointer"
              >
                <Pencil size={10} /> Edit
              </button>
              <button
                onClick={() => {
                  window.electron?.secrets?.delete("llm", active.id, "apiKey");
                  deleteSavedProvider(active.id);
                }}
                className="px-2 py-1 text-[0.714rem] rounded border border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--danger)] hover:text-[var(--danger)] transition-colors flex items-center gap-1 cursor-pointer"
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
          onSave={async ({ name, baseUrl, model, rawKey, keyDirty }) => {
            if (editing === "new") {
              // Create first (no key), then store the raw key in the OS keychain
              // and save the returned reference token — the raw key never lands
              // in the store, localStorage, or the settings cache.
              const id = addSavedProvider({ name, baseUrl, model, apiKey: "" }, kind);
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
              const patch: { name: string; baseUrl: string; model: string; apiKey?: string } = { name, baseUrl, model };
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
  onSave: (data: { name: string; baseUrl: string; model: string; rawKey: string; keyDirty: boolean }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "https://api.openai.com");
  const [model, setModel] = useState(initial?.model ?? defaultModel);
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

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({ name: name.trim(), baseUrl: baseUrl.trim(), model: model.trim(), rawKey: keyInput.trim(), keyDirty });
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
          <span className="text-[0.714rem] text-[var(--text-tertiary)]">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="OpenAI" className={inputCls} />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-[0.714rem] text-[var(--text-tertiary)]">Default model</span>
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
          <span className="text-[0.714rem] text-[var(--text-tertiary)]">Base URL</span>
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => { setBaseUrl(e.target.value); resetModels(); }}
            placeholder="https://api.openai.com"
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[0.714rem] text-[var(--text-tertiary)]">API Key</span>
          <input
            type="password"
            value={keyInput}
            onChange={(e) => { setKeyInput(e.target.value); setKeyDirty(true); resetModels(); }}
            placeholder={hadKey ? "•••••••• stored — type to replace" : "sk-… (optional for local)"}
            className={inputCls}
          />
          <span className="text-[0.643rem] text-[var(--text-tertiary)]">Stored in your OS keychain, never synced.</span>
        </label>
      </div>
      {keyInfo && (
        <div className="flex items-center gap-1.5">
          <CreditsBadge info={keyInfo} />
        </div>
      )}
      {saveError && (
        <p className="text-[0.714rem] text-[var(--danger)]">{saveError}</p>
      )}
      <div className="flex justify-end gap-1.5 pt-0.5">
        <button
          onClick={onCancel}
          className="px-2.5 py-1 text-[0.714rem] rounded border border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors flex items-center gap-1 cursor-pointer"
        >
          <X size={11} /> Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!canSave}
          className={cn(
            "px-2.5 py-1 text-[0.714rem] rounded border transition-colors flex items-center gap-1",
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
