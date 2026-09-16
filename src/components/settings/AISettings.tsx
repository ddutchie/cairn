"use client";

import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { useEffect, useState } from "react";
import { Download, Plus, Trash2, Sparkles, X, FolderOpen, RefreshCw, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import { contextLimitForModel, modelInfoForModel } from "@/lib/models-dev";
import { SettingsGroup, SettingsRow, Toggle, StepperSettingsRow } from "./shared";
import { ProviderManager } from "./ProviderManager";
import { BrowseProvidersModal } from "./tools/BrowseProvidersModal";
import { BrowsePersonalitiesModal } from "@/components/chat/BrowsePersonalitiesModal";
import { MAX_PERSONALITY_PROMPT_CHARS } from "../../../shared/chat/registry-schema";
import { Button } from "@/components/ui/button";
import { useAgentPreviews } from "./tools/useAgentPreviews";
import { PromptPreview, SharedSectionsList, SurfaceToolsPanel, ToolsLegend } from "./tools/preview-components";

// ── Local servers (BYO inference) ───────────────────────────────────────────
// Cairn no longer ships an inference engine. Run Ollama, LM Studio, or
// llama.cpp yourself and add it here as a saved provider — chat, agent, and
// automations treat it like any other OpenAI-compatible endpoint (no API key
// needed for localhost). Detection is a best-effort direct fetch from the
// renderer; a server that blocks browser access can still be added manually
// in ProviderManager below.

interface DetectedServer {
  key: string;
  name: string;
  baseUrl: string;
  models: string[];
}

const LOCAL_SERVER_CANDIDATES = [
  { key: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  { key: "lmstudio", name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
  { key: "llamacpp", name: "llama.cpp server", baseUrl: "http://127.0.0.1:8080/v1" },
];

async function probeLocalServer(baseUrl: string, timeoutMs = 4000): Promise<{ ok: boolean; models: string[] }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: ac.signal });
    if (!res.ok) return { ok: false, models: [] };
    const data = await res.json() as { data?: Array<{ id?: string }> };
    const ids = (data?.data ?? []).map((m) => m?.id).filter((id): id is string => !!id);
    return { ok: true, models: ids.slice(0, 12) };
  } catch {
    return { ok: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

function LocalServersCard() {
  const addSavedProvider = useCairnStore((s) => s.addSavedProvider);
  const savedProviders = useCairnStore((s) => s.aiConfig.savedProviders ?? []);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [found, setFound] = useState<DetectedServer[]>([]);

  async function handleScan() {
    setScanning(true);
    try {
      const results = await Promise.all(
        LOCAL_SERVER_CANDIDATES.map(async (c) => {
          const probe = await probeLocalServer(c.baseUrl);
          // A server counts as detected when /v1/models answers — even with
          // an empty list (llama.cpp serves an empty list until a model is
          // loaded). Empty-list servers are shown but can't prefill a model.
          return probe.ok || probe.models.length > 0
            ? { ...c, models: probe.models }
            : null;
        }),
      );
      setFound(results.filter((r): r is DetectedServer => r !== null));
      setScanned(true);
    } finally {
      setScanning(false);
    }
  }

  function handleAdd(server: DetectedServer) {
    addSavedProvider(
      {
        name: `${server.name} (local)`,
        baseUrl: server.baseUrl,
        model: server.models[0] ?? "",
        apiKey: "",
        apiMode: "completions",
      },
      "ai",
    );
  }

  const addedUrls = new Set(savedProviders.map((p) => p.baseUrl.replace(/\/$/, "")));

  return (
    <SettingsRow
      label="Local servers"
      description="Cairn doesn't bundle an inference engine — run Ollama, LM Studio, or llama.cpp yourself, then add it as a provider. No API key needed for localhost."
      controlClassName="min-w-0 @sm:self-auto @sm:max-w-[62%]"
    >
      <div className="flex flex-col gap-2 min-w-0 w-full">
        <button
          onClick={handleScan}
          disabled={scanning}
          className="px-2.5 py-1.5 text-[0.714rem] rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50 self-start"
        >
          <Server size={12} />
          {scanning ? "Scanning localhost…" : scanned ? "Scan again" : "Detect local servers"}
        </button>
        {scanned && found.length === 0 && (
          <p className="text-[0.714rem] text-[var(--text-tertiary)]">
            Nothing answering on the usual ports. Start Ollama (`ollama serve`), LM Studio (server tab), or
            `llama-server`, then scan again — or add the endpoint manually below.
          </p>
        )}
        {found.map((server) => {
          const already = addedUrls.has(server.baseUrl.replace(/\/$/, ""));
          return (
            <div
              key={server.key}
              className="flex items-center justify-between gap-2 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-2.5 py-2"
            >
              <div className="min-w-0">
                <p className="text-[0.714rem] font-semibold text-[var(--text-primary)]">
                  {server.name}
                  <span className="ml-1.5 font-mono font-normal text-[var(--text-tertiary)] break-all">{server.baseUrl}</span>
                </p>
                <p className="text-[0.65rem] text-[var(--text-tertiary)] truncate">
                  {server.models.length > 0 ? server.models.join(", ") : "reachable — no models listed yet"}
                </p>
              </div>
              <button
                onClick={() => handleAdd(server)}
                disabled={already}
                className="shrink-0 px-2.5 py-1 text-[0.714rem] rounded-md border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent-dim)] transition-colors cursor-pointer disabled:opacity-40"
              >
                {already ? "Added" : "Add"}
              </button>
            </div>
          );
        })}
      </div>
    </SettingsRow>
  );
}

// ── Chat prompt + tools preview ─────────────────────────────────────────────
// Chat system prompt (assembled dsh sections + skills) and the tools the chat
// surface exposes. Same card style as the Coding Agents and MCP tabs.

function ChatPreviewSection() {
  const previews = useAgentPreviews();
  const { workspacePath, systemPrompt, sections, inventory, loading, error, reload } = previews;
  const chatTools = inventory?.chat ?? [];

  return (
    <SettingsGroup
      title="Chat Prompt & Tools"
      description="SKILL.md files discovered in your workspace are automatically loaded into the chat context. The section assembly below is the shared global context both chat and coding turns send — only the identity section carries the chat prompt. Chat tools have no filesystem access by design."
    >
      {/* Refresh */}
      <div className="flex items-center justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={reload}
          disabled={loading}
          className={cn(loading && "opacity-50")}
        >
          <RefreshCw size={11} className={cn(loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Workspace path context */}
      {workspacePath && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
          <FolderOpen size={11} className="text-[var(--text-tertiary)] flex-shrink-0" />
          <span className="text-[0.714rem] font-mono text-[var(--text-tertiary)] truncate">{workspacePath}</span>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-4 py-3">
          <p className="text-xs text-[var(--danger)]">{error}</p>
        </div>
      )}

      {systemPrompt !== null && (
        <div className="space-y-3">
          {sections && sections.length > 0 && (
            <SharedSectionsList sections={sections} toolsCount={chatTools.length} />
          )}
          <PromptPreview systemPrompt={systemPrompt} />
          {/* Skills are a coding-agent capability — chat neither resolves the
              skill tool nor receives the catalog. Listed on Coding Agents. */}
          <p className="text-[0.65rem] text-[var(--text-tertiary)]">
            Workspace skills load on the coding agent only — see the Coding Agents tab.
          </p>
        </div>
      )}

      {inventory && (
        <div className="space-y-3">
          <SurfaceToolsPanel
            tools={chatTools}
            footnote="Deletes are approval-gated on chat. Filesystem tools (read/edit/bash) live on the coding agent."
          />
          <ToolsLegend />
        </div>
      )}

      {loading && (
        <div className="py-8 text-center">
          <RefreshCw size={16} className="mx-auto animate-spin text-[var(--text-tertiary)] opacity-50" />
        </div>
      )}
    </SettingsGroup>
  );
}

export function AISettings() {
  const { aiConfig, setAIConfig, setPersonality, removePersonality, createCustomPersonality } = useCairnStore(useShallow((s) => ({
    aiConfig:             s.aiConfig,
    setAIConfig:          s.setAIConfig,
    setPersonality:       s.setPersonality,
    removePersonality:    s.removePersonality,
    createCustomPersonality: s.createCustomPersonality,
  })));

  // General config destructuring. Connection fields (baseUrl/apiKey/model) are
  // now managed entirely by the ProviderManager switcher below; here we only
  // need `model` (for the context lookup) and the behavioural fields.
  const { model, aiEnabled } = aiConfig;

  function updateAIConfig(patch: Partial<typeof aiConfig>) {
    setAIConfig(patch);
  }

  // Look up the current model's context window from models.dev (cached). When
  // Auto is enabled, the detected value is applied to contextLimit automatically
  // as the model changes; the user can still override with a manual value or
  // preset (which turns Auto off). Best-effort — null when not in the catalog.
  const contextAuto = aiConfig.contextAuto ?? true;
  const [detectedContext, setDetectedContext] = useState<number | null>(null);
  const [autoState, setAutoState] = useState<"idle" | "loading" | "detected" | "not_found">("idle");
  const [browsingProviders, setBrowsingProviders] = useState(false);
  const [browsingPersonalities, setBrowsingPersonalities] = useState(false);
  const [creatingPersonality, setCreatingPersonality] = useState(false);
  const [personaName, setPersonaName] = useState("");
  const [personaDescription, setPersonaDescription] = useState("");
  const [personaPrompt, setPersonaPrompt] = useState("");
  useEffect(() => {
    let cancelled = false;
    const id = (model ?? "").trim();
    if (!id) { setDetectedContext(null); setAutoState("idle"); return; } // eslint-disable-line react-hooks/set-state-in-effect
    setAutoState("loading");
    contextLimitForModel(id, 0).then((n) => {
      if (cancelled) return;
      const found = n > 0 ? n : null;
      setDetectedContext(found);
      setAutoState(found ? "detected" : "not_found");
      // Auto-apply the detected value when Auto mode is on. Read the LATEST config
      // from the store (not the captured render value) to avoid stale-closure
      // races when switching models quickly, and only write when it differs.
      if (found) {
        const cur = useCairnStore.getState().aiConfig;
        if ((cur.contextAuto ?? true) && cur.contextLimit !== found) {
          setAIConfig({ contextLimit: found });
        }
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, contextAuto]);

  // Max output tokens. Auto (default) sends a generous 32K cap (bounded by the
  // model's advertised limit.output) so the model finishes naturally without
  // hitting a tiny endpoint default; a manual value is a deliberate ceiling.
  // We surface the model's limit.output (when known) as guidance next to the field.
  const maxOutputAuto = aiConfig.maxOutputAuto ?? true;
  const [advertisedMaxOutput, setAdvertisedMaxOutput] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const id = (model ?? "").trim();
    if (!id) { setAdvertisedMaxOutput(null); return; } // eslint-disable-line react-hooks/set-state-in-effect
    modelInfoForModel(id).then((info) => {
      if (cancelled) return;
      setAdvertisedMaxOutput(info?.maxOutput ?? null);
    });
    return () => { cancelled = true; };
  }, [model]);

  // Whether the selected model supports temperature control (models.dev
  // `temperature`). false = the vendor manages sampling internally, so a
  // client-forced value is ignored and nothing is sent. null/undefined = unknown.
  const [temperatureCapability, setTemperatureCapability] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    const id = (model ?? "").trim();
    if (!id) { setTemperatureCapability(null); return; } // eslint-disable-line react-hooks/set-state-in-effect
    modelInfoForModel(id).then((info) => {
      if (cancelled) return;
      setTemperatureCapability(info?.temperature ?? null);
    });
    return () => { cancelled = true; };
  }, [model]);

  // Shared Max-steps control — rendered after the provider blocks.
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
        description="Configure endpoints for the main AI Chat panel, in-editor inline text actions, PRD writer, and summaries. Works with cloud APIs and user-run local servers (Ollama, LM Studio)."
      >
        <LocalServersCard />

          <>
            {/* Install a preset provider from the cairn-community catalog. */}
            <SettingsRow
              label="Community providers"
              description="Install a ready-made OpenAI-compatible provider (endpoint + default model) and just enter your API key. Added to your saved providers below."
            >
              <button
                onClick={() => setBrowsingProviders(true)}
                className="px-2.5 py-1.5 text-[0.714rem] rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                <Download size={12} /> Browse Community
              </button>
            </SettingsRow>

            <ProviderManager kind="ai" />

            {/* Max Steps — applies to all providers */}
            {maxStepsRow}

            {/* Temperature */}
            <StepperSettingsRow
              label="Temperature"
              description={
                aiConfig.temperature == null
                  ? temperatureCapability === false
                    ? `Auto: no temperature is sent for "${model}" — models.dev reports it doesn't support temperature control, so the model manages sampling itself.`
                    : `Auto: no temperature is sent, so "${model}" uses its own default (e.g. GLM defaults to 1.0). Set a value to override for models that support it.`
                  : temperatureCapability === false
                    ? `"${model}" doesn't support temperature control (per models.dev) — this value is ignored and nothing is sent.`
                    : `Sent to "${model}" when it supports temperature. Lower = more deterministic, higher = more creative. Tap Auto to let the model use its own default.`
              }
              icon="thermometer"
              value={aiConfig.temperature ?? 0.3}
              onChange={(v) => updateAIConfig({ temperature: v })}
              presets={[0.1, 0.3, 0.5, 0.7, 1.0]}
              min={0}
              max={1}
              step={0.05}
              autoActive={aiConfig.temperature == null}
              onAuto={() => updateAIConfig({ temperature: undefined })}
              autoSuppressesValue
              suppressedPlaceholder="Auto"
            />

            {/* Context window — auto-detected from models.dev, with manual override */}
            <StepperSettingsRow
              label="Context window"
              description={
                contextAuto && autoState === "detected" && detectedContext
                  ? `Auto: using ${detectedContext.toLocaleString()} tokens detected from models.dev for "${model}". Set a value to override.`
                  : contextAuto && autoState === "not_found"
                    ? `"${model}" isn't in the models.dev catalog, so Auto can't detect its size. Set the context size manually.`
                    : autoState === "detected" && detectedContext
                      ? `Manual override. models.dev reports ${detectedContext.toLocaleString()} tokens for "${model}" — tap Auto to use it.`
                      : "Token limit used to render the chat context ring. Tap Auto to detect it from models.dev, or set a value."
              }
              icon="layers"
              value={aiConfig.contextLimit ?? 128000}
              onChange={(v) => updateAIConfig({ contextLimit: v, contextAuto: false })}
              presets={[8000, 32000, 128000, 200000]}
              min={1000}
              max={2000000}
              step={1000}
              inputWidth="w-28"
              formatPreset={(n) => (n >= 1000 ? `${n / 1000}k` : String(n))}
              autoValue={detectedContext ?? undefined}
              autoState={contextAuto ? autoState : "idle"}
              autoActive={contextAuto}
              onAuto={() =>
                updateAIConfig({
                  contextAuto: true,
                  contextLimit: detectedContext ?? aiConfig.contextLimit ?? 128000,
                })
              }
            />

            {/* Max output tokens — Auto (default) sends a bounded 32K cap (clamped to
                the model's limit.output) so the model finishes naturally; a
                manual value is a deliberate cost/latency ceiling. */}
            <StepperSettingsRow
              label="Max output tokens"
              description={
                maxOutputAuto
                  ? advertisedMaxOutput
                    ? `Auto: a 32K cap, clamped to "${model}"'s ${advertisedMaxOutput.toLocaleString()} output tokens (per models.dev). The model finishes on its own unless its limit is lower. Recommended, especially for reasoning models. Set a value only to cap cost.`
                    : "Auto: a 32K cap so the model finishes on its own (clamped to the model's output limit when models.dev knows it). Recommended, especially for reasoning models, which need room to think before answering. Set a value only to cap cost per reply."
                  : advertisedMaxOutput
                    ? `Manual cap on a single reply. Reasoning models count their thinking against this, so too low a value can cut them off before they answer. "${model}" supports up to ${advertisedMaxOutput.toLocaleString()} tokens (models.dev). Tap Auto for the bounded 32K cap.`
                    : "Manual cap on a single reply's length. Reasoning models count their thinking against this, so too low a value can cut them off before they answer. Tap Auto for the bounded 32K cap."
              }
              icon="gauge"
              value={aiConfig.maxOutputTokens ?? 8192}
              onChange={(v) => updateAIConfig({ maxOutputTokens: v, maxOutputAuto: false })}
              presets={[4096, 8192, 16384, 32768, 65536]}
              min={256}
              max={advertisedMaxOutput ?? 384000}
              step={256}
              inputWidth="w-28"
              formatPreset={(n) => (n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : String(n))}
              autoState={maxOutputAuto ? "detected" : "idle"}
              autoActive={maxOutputAuto}
              autoSuppressesValue
              suppressedPlaceholder="Auto (32K)"
              onAuto={() => updateAIConfig({ maxOutputAuto: true })}
            />

            {/* Subagents — dispatch → research/write architecture. */}
            <SettingsRow
              label="Subagents"
              description="Route chat through a dispatcher that delegates research and writing to focused sub-agents. Cheaper on long, tool-heavy tasks; adds overhead on quick questions."
            >
              <Toggle
                checked={aiConfig.subagentsEnabled ?? false}
                onChange={(v) => updateAIConfig({ subagentsEnabled: v })}
                label="Enable subagents"
              />
            </SettingsRow>
          </>
      </SettingsGroup>

      {/* ── Chat personalities ── */}
      <SettingsGroup
        title="Chat personality"
        description="A style layer appended to the chat system prompt — behavioral rules that shape tone. Pick one per session in the chat input, or manage them here."
      >
        <SettingsRow
          label="Community personalities"
          description="Install ready-made tone & style rules from the cairn-community catalog. The full prompt is shown before install."
        >
          <button
            onClick={() => setBrowsingPersonalities(true)}
            className="px-2.5 py-1.5 text-[0.714rem] rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <Download size={12} /> Browse Community
          </button>
        </SettingsRow>

        {aiConfig.installedPersonalities && aiConfig.installedPersonalities.length > 0 && (
          <SettingsRow
            label="Installed"
            description="The active one applies to chat. Remove any entry freely — nothing is sent to the model until it's selected."
          >
            <div className="flex flex-col gap-1.5 w-full min-w-52">
              {/* None — no personality layer */}
              <button
                type="button"
                className={cn(
                  "flex items-center gap-2 rounded-md border px-2.5 py-2 cursor-pointer transition-colors text-left",
                  !aiConfig.personalityId
                    ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
                    : "border-[var(--border)] hover:bg-[var(--surface-2)]",
                )}
                onClick={() => setPersonality(null)}
                title="No personality layer"
                aria-label="Select None — no personality layer"
              >
                <Sparkles size={12} className="text-[var(--text-tertiary)] shrink-0" />
                <span className="text-[0.714rem] text-[var(--text-secondary)] flex-1">None</span>
                <span className={cn("text-[0.65rem] shrink-0", !aiConfig.personalityId ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]")}>
                  {!aiConfig.personalityId ? "Active" : "Inactive"}
                </span>
              </button>
              {aiConfig.installedPersonalities.map((p) => {
                const isActive = p.id === aiConfig.personalityId;
                return (
                  <div
                    key={p.id}
                    className={cn(
                      "flex items-center gap-2 rounded-md border transition-colors",
                      isActive
                        ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
                        : "border-[var(--border)]",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setPersonality(isActive ? null : p.id)}
                      title={isActive ? "Click to switch to None" : "Set as active"}
                      aria-label={`${isActive ? "Deactivate" : "Activate"} ${p.name}`}
                      className={cn(
                        "flex items-center gap-2 px-2.5 py-2 cursor-pointer transition-colors text-left flex-1 min-w-0",
                        !isActive && "hover:bg-[var(--surface-2)]",
                      )}
                    >
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ background: p.brandColor ?? "var(--text-tertiary)" }}
                      />
                      <span className="text-[0.714rem] text-[var(--text-secondary)] flex-1 truncate">{p.name}</span>
                      {p.source === "custom" && (
                        <span className="text-[0.6rem] text-[var(--text-tertiary)] border border-[var(--border)] rounded px-1 leading-3">custom</span>
                      )}
                      <span className={cn("text-[0.65rem] shrink-0", isActive ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]")}>
                        {isActive ? "Active" : "Inactive"}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => removePersonality(p.id)}
                      className="text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-colors shrink-0 mr-2"
                      title="Remove"
                      aria-label={`Remove ${p.name}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          </SettingsRow>
        )}

        <SettingsRow
          label="Create your own"
          description="Write your own behavioral rules — e.g. 'Always talk in ASD-STE100 Simplified English'. Rules, not a new identity: the Cairn assistant stays the assistant."
        >
          <button
            onClick={() => setCreatingPersonality((v) => !v)}
            className="px-2.5 py-1.5 text-[0.714rem] rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            {creatingPersonality ? <X size={12} /> : <Plus size={12} />}
            {creatingPersonality ? "Cancel" : "New personality"}
          </button>
        </SettingsRow>

        {creatingPersonality && (
          <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
            <input
              className="w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 focus:outline-none"
              placeholder="Name (e.g. Concise)"
              value={personaName}
              onChange={(e) => setPersonaName(e.target.value)}
            />
            <input
              className="w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 focus:outline-none"
              placeholder="Description (optional)"
              value={personaDescription}
              onChange={(e) => setPersonaDescription(e.target.value)}
            />
            <textarea
              className="w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 focus:outline-none resize-none min-h-24"
              placeholder="Behavioral rules appended to the chat system prompt. Write rules, not a 'You are …' identity."
              value={personaPrompt}
              maxLength={MAX_PERSONALITY_PROMPT_CHARS}
              onChange={(e) => setPersonaPrompt(e.target.value)}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => { setCreatingPersonality(false); setPersonaName(""); setPersonaDescription(""); setPersonaPrompt(""); }}
                className="px-2.5 py-1.5 text-[0.714rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
              >
                Cancel
              </button>
              <button
                disabled={!personaName.trim() || !personaPrompt.trim()}
                onClick={() => {
                  const id = createCustomPersonality({
                    name: personaName.trim(),
                    description: personaDescription.trim() || undefined,
                    prompt: personaPrompt.trim(),
                  });
                  setPersonality(id);
                  setCreatingPersonality(false);
                  setPersonaName("");
                  setPersonaDescription("");
                  setPersonaPrompt("");
                }}
                className="px-2.5 py-1.5 text-[0.714rem] rounded-md bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center gap-1.5 cursor-pointer"
              >
                <Sparkles size={12} /> Create
              </button>
            </div>
          </div>
        )}
      </SettingsGroup>

      {/* ── Chat prompt & tools ── */}
      <ChatPreviewSection />

      {browsingProviders && <BrowseProvidersModal onClose={() => setBrowsingProviders(false)} />}
      {browsingPersonalities && <BrowsePersonalitiesModal onClose={() => setBrowsingPersonalities(false)} />}
    </div>
  );
}
