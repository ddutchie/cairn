"use client";

import { useState, useEffect } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { Plus, Pencil, Trash2, Check, X, Server, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SavedProvider } from "@/store/slices/ui";
import { SettingsRow } from "./shared";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown";
import { ModelPicker } from "@/components/ui/model-picker";
import { useEndpointConfig } from "./endpoint-components";

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
    savedProviders, activeProviderId,
    addSavedProvider, updateSavedProvider, deleteSavedProvider, selectProvider,
  } = useCairnStore(useShallow((s) => ({
    // The list is always shared — read it from aiConfig.
    savedProviders:      s.aiConfig.savedProviders,
    // Active id + select target depend on which config this instance drives.
    activeProviderId:    kind === "agent" ? s.agentConfig.activeProviderId : s.aiConfig.activeProviderId,
    addSavedProvider:    s.addSavedProvider,
    updateSavedProvider: s.updateSavedProvider,
    deleteSavedProvider: s.deleteSavedProvider,
    selectProvider:      kind === "agent" ? s.selectAgentProvider : s.selectSavedProvider,
  })));

  const providers = savedProviders ?? EMPTY_PROVIDERS;
  const active = providers.find((p) => p.id === activeProviderId);

  // null = form closed; "new" = adding; otherwise the id being edited.
  const [editing, setEditing] = useState<null | "new" | string>(null);

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
              <DropdownMenuTrigger asChild disabled={providers.length === 0}>
                <button
                  className={cn(
                    "flex-1 flex items-center justify-between gap-2 pl-2.5 pr-2 py-1.5 text-xs rounded-md",
                    "bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)]",
                    "hover:border-[var(--muted)] focus:outline-none focus:border-[var(--accent)] transition-colors cursor-pointer",
                    providers.length === 0 && "opacity-50 cursor-not-allowed",
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
                      <span className="truncate text-[0.714rem] text-[var(--text-tertiary)] font-mono">{p.model}</span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              onClick={() => setEditing("new")}
              aria-label="Add provider"
              title="Add a provider"
              className="px-2 py-1.5 text-[0.714rem] rounded-md border border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)] transition-colors flex items-center gap-1 cursor-pointer"
            >
              <Plus size={11} /> Add
            </button>
          </div>

          {active && (
            <div className="flex gap-1.5">
              <button
                onClick={() => setEditing(active.id)}
                className="px-2 py-1 text-[0.714rem] rounded border border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)] transition-colors flex items-center gap-1 cursor-pointer"
              >
                <Pencil size={10} /> Edit
              </button>
              <button
                onClick={() => deleteSavedProvider(active.id)}
                className="px-2 py-1 text-[0.714rem] rounded border border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--danger)] hover:text-[var(--danger)] transition-colors flex items-center gap-1 cursor-pointer"
              >
                <Trash2 size={10} /> Delete
              </button>
            </div>
          )}
        </div>
      </SettingsRow>

      {editing && (
        <ProviderForm
          key={editing}
          initial={editingProvider}
          defaultModel={kind === "agent" ? "gpt-4o" : "gpt-4o-mini"}
          onCancel={() => setEditing(null)}
          onSave={(data) => {
            if (editing === "new") addSavedProvider(data, kind);
            else updateSavedProvider(editing, data);
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
  onSave: (data: Omit<SavedProvider, "id">) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "https://api.openai.com");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [model, setModel] = useState(initial?.model ?? defaultModel);

  // Fetch this provider's own model list (from its baseUrl/apiKey) so the model
  // picker can offer real options + a Refresh, matching the chat model picker.
  // Hydrate from the per-endpoint cache (or fetch once) on open — no hardcoded
  // fallbacks, so the dropdown only ever lists real models.
  const { availableModels, fetchModels, ensureModels, resetModels, modelsLoading, testState } = useEndpointConfig();
  useEffect(() => {
    ensureModels(baseUrl, apiKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canSave = name.trim().length > 0 && baseUrl.trim().length > 0;

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
          <span className="text-[0.714rem] text-[var(--text-tertiary)]">Model</span>
          <ModelPicker
            value={model}
            options={availableModels}
            loading={modelsLoading}
            errored={testState === "error"}
            placeholder={defaultModel}
            size="md"
            onChange={setModel}
            onRefresh={() => fetchModels(baseUrl, apiKey)}
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
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); resetModels(); }}
            placeholder="sk-… (optional for local)"
            className={inputCls}
          />
        </label>
      </div>
      <div className="flex justify-end gap-1.5 pt-0.5">
        <button
          onClick={onCancel}
          className="px-2.5 py-1 text-[0.714rem] rounded border border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors flex items-center gap-1 cursor-pointer"
        >
          <X size={11} /> Cancel
        </button>
        <button
          onClick={() => canSave && onSave({ name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() })}
          disabled={!canSave}
          className={cn(
            "px-2.5 py-1 text-[0.714rem] rounded border transition-colors flex items-center gap-1",
            canSave
              ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)] hover:bg-[var(--accent-dim)] cursor-pointer"
              : "border-[var(--border)] text-[var(--text-tertiary)] opacity-50 cursor-not-allowed",
          )}
        >
          <Check size={11} /> {initial ? "Save" : "Add"}
        </button>
      </div>
    </div>
  );
}
