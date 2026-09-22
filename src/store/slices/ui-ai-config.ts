/**
 * UI AI-config slice — AIConfig/AgentConfig, saved providers, personalities.
 * Split out of `slices/ui.ts` (Phase 3); `slices/ui.ts` re-combines the
 * appearance + ai-config + layout slices with an identical store shape.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import { storage } from "@/lib/storage";
import { id as genId } from "@/lib/utils";
import { DEFAULT_AI_CONFIG, DEFAULT_AGENT_CONFIG, AI_CONFIG_KEY, AGENT_CONFIG_KEY } from "@/lib/constants";

// ── AI / MCP config ───────────────────────────────────────────────────────────

/**
 * A named, reusable cloud/local API connection. Lets the user save several
 * OpenAI-compatible endpoints (e.g. "OpenAI", "OpenRouter", "Local Ollama") and
 * switch between them without retyping the base URL, key, and model each time.
 * Applies only to the cloud/local API provider — On-Device Llama is unaffected.
 */
export interface SavedProvider {
  /** Stable id (uuid). */
  id: string;
  /** User-facing label shown in the switcher. */
  name: string;
  /** OpenAI-compatible chat completions endpoint root. */
  baseUrl: string;
  /** API key. Empty = use the server-side OPENAI_API_KEY env var / keyless local. */
  apiKey: string;
  /**
   * Default model id for this provider. Used to SEED a surface's model when it
   * first selects this provider. Each consumer (AI Chat, coding agent) then
   * keeps its own `model` on `aiConfig`/`agentConfig` and can diverge — so the
   * same provider can run a different model in chat vs. the agent.
   */
  model: string;
  /** Where this provider came from. Absent = "manual" (legacy rows). */
  source?: "manual" | "community";
  /** Community catalog id when `source === "community"` — dedups re-installs. */
  communityId?: string;
  /**
   * Wire protocol for this endpoint. EXPLICIT, never auto-probed: Cairn defaults
   * to "completions" (the universally-supported chat-completions surface) and
   * only uses "responses" or "anthropic-messages" when the user opts in.
   * Auto-probing was removed because a transient failure could flip the transport
   * across restarts, corrupting cross-API replay of the resumed session log.
   * Absent = "completions".
   */
  apiMode?: ApiMode;
}

/** OpenAI-compatible / Anthropic wire protocol for a provider endpoint.
 *  Explicit — Cairn never auto-probes. */
export type ApiMode = "responses" | "completions" | "anthropic-messages";

/**
 * An installed chat personality — a set of behavioral rules appended to the
 * chat system prompt to shape the assistant's tone and style. Installed from
 * the cairn-community catalog (`source: "community"`) or authored locally by
 * the user (`source: "custom"`). Lives on `aiConfig.installedPersonalities`;
 * the active one is `aiConfig.personalityId` (absent = Default, no layer).
 */
export interface InstalledPersonality {
  /** Stable id (uuid). */
  id: string;
  /** Display name shown in the picker. */
  name: string;
  /** One line shown in the picker / browse card. */
  description?: string;
  /** Behavioral rules appended to the chat system prompt. */
  prompt: string;
  /** Where it came from — the community catalog or a local custom entry. */
  source: "community" | "custom";
  /** Community catalog id when `source === "community"` — dedups re-installs. */
  communityId?: string;
  /** Catalog version when community (for "update available" checks). */
  version?: string;
  /** Author handle when community. */
  author?: string;
  /** Tint for the picker dot. */
  brandColor?: string;
  /** Attribution/source link when community (rendered as a link). */
  homepage?: string;
}

/**
 * The connection-carrying subset shared by AIConfig and AgentConfig, so the
 * mirror-into-config helpers below can operate on either one generically. The
 * saved-provider *list* itself is shared and lives on aiConfig.savedProviders.
 */
type ProviderCarrier = {
  baseUrl: string;
  apiKey: string;
  model: string;
  activeProviderId?: string;
};

/**
 * Mirror a provider's connection into a config + mark it that config's active.
 * Seeds `model` from the provider default (used on select/add). Once selected,
 * the config's model is independent — see `reconcileConfig`, which preserves it.
 */
function mirrorProvider<C extends ProviderCarrier>(config: C, p: SavedProvider): C {
  return { ...config, activeProviderId: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model };
}

/**
 * De-duplicate a saved-provider list by id, keeping the LAST occurrence of each
 * id (so a later edit wins over an earlier stale copy) while preserving order.
 * Guards against duplicate React keys / doubled entries that can otherwise creep
 * into persisted state, and self-heals any already-corrupted stored list on the
 * next write or on hydration.
 */
export function dedupeProviders(list: SavedProvider[]): SavedProvider[] {
  const byId = new Map<string, SavedProvider>();
  for (const p of list) byId.set(p.id, p);
  // Preserve first-seen order while using the last value for each id.
  const seen = new Set<string>();
  const out: SavedProvider[] = [];
  for (const p of list) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(byId.get(p.id)!);
  }
  return out;
}

/** Re-sync only the CONNECTION (baseUrl/apiKey) from a provider, keeping the
 *  config's own chosen model. Used when the shared list is edited/deleted. */
function syncConnection<C extends ProviderCarrier>(config: C, p: SavedProvider): C {
  return { ...config, activeProviderId: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey };
}

/**
 * Reconcile a config after the shared provider list changed. Only touches a
 * config that had a provider selected: if its active provider still exists,
 * re-sync its connection (baseUrl/apiKey) while KEEPING the config's own model;
 * if it was just deleted, fall back to the first remaining provider (seeding
 * that provider's default model). A config with NO active provider is left
 * untouched — an unselected surface must never inherit list[0] or the other
 * surface's choice.
 */
function reconcileConfig<C extends ProviderCarrier>(config: C, list: SavedProvider[]): C {
  if (!config.activeProviderId) return config; // never auto-select for an unselected surface
  const active = list.find((p) => p.id === config.activeProviderId);
  if (active) return syncConnection(config, active); // keep the config's own model
  const fallback = list[0];
  return fallback ? mirrorProvider(config, fallback) : config;
}

/** Persist an AIConfig to localStorage + the Electron backend cache. */
function persistAi(next: AIConfig): void {
  storage.set(AI_CONFIG_KEY, next);
  if (typeof window !== "undefined" && window.electron?.saveAiSettings) {
    window.electron.saveAiSettings(next as unknown as Record<string, unknown>).catch(() => {});
  }
}

/** Persist an AgentConfig to localStorage + the Electron backend cache. */
function persistAgent(next: AgentConfig): void {
  storage.set(AGENT_CONFIG_KEY, next);
  if (typeof window !== "undefined" && window.electron?.saveAgentSettings) {
    window.electron.saveAgentSettings(next as unknown as Record<string, unknown>).catch(() => {});
  }
}

/** True if a value is a keychain reference token (not a raw key). */
function isKeyRef(v: string | undefined | null): boolean {
  return typeof v === "string" && v.startsWith("secret://");
}

/**
 * One-time migration: move any RAW LLM API key found in the persisted configs
 * (legacy top-level `apiKey`, or `savedProviders[].apiKey`) into the OS keychain
 * and replace it with a `secret://llm:…/apiKey` reference token. Returns the
 * possibly-updated configs (or the originals if nothing changed / no electron).
 *
 * Runs during hydration so upgrading users' plaintext keys are relocated to the
 * keychain and scrubbed from localStorage + the settings cache on next launch.
 */
export async function migrateLlmKeysToKeychain(
  ai: AIConfig,
  agent: AgentConfig,
): Promise<{ ai: AIConfig; agent: AgentConfig; changed: boolean }> {
  let changed = false;

  // De-duplicate the saved-provider list by id up front, BEFORE the secrets
  // check below. A corrupted/doubled persisted list (→ duplicate React keys)
  // must self-heal on hydration even when the keychain bridge is unavailable
  // (web build, or Electron without the secrets API).
  const rawProviders = ai.savedProviders ?? [];
  const dedupedProviders = dedupeProviders(rawProviders);
  if (dedupedProviders.length !== rawProviders.length) {
    changed = true;
    ai = { ...ai, savedProviders: dedupedProviders };
  }

  const secrets = typeof window !== "undefined" ? window.electron?.secrets : undefined;
  if (!secrets) return { ai, agent, changed };

  // 1. Saved providers: convert each provider's raw key to a keychain ref.
  const providers = dedupedProviders;
  const migratedProviders: SavedProvider[] = [];
  for (const p of providers) {
    if (p.apiKey && !isKeyRef(p.apiKey)) {
      try {
        const ref = await secrets.set("llm", p.id, "apiKey", p.apiKey);
        migratedProviders.push({ ...p, apiKey: ref });
        changed = true;
      } catch {
        // Keychain unavailable — drop the raw key rather than keep it in plaintext.
        migratedProviders.push({ ...p, apiKey: "" });
        changed = true;
      }
    } else {
      migratedProviders.push(p);
    }
  }

  let nextAi = ai;
  if (changed) nextAi = { ...ai, savedProviders: migratedProviders };

  // 2. Mirror the active provider's (now-ref) key onto the top-level field.
  const activeAi = migratedProviders.find((p) => p.id === nextAi.activeProviderId);
  if (activeAi) {
    if (nextAi.apiKey !== activeAi.apiKey) {
      nextAi = { ...nextAi, apiKey: activeAi.apiKey };
      changed = true; // persist the refreshed top-level key
    }
  } else if (nextAi.apiKey && !isKeyRef(nextAi.apiKey)) {
    // No provider selected but a legacy raw top-level key exists: store it under
    // a stable synthetic id so it survives as a ref (keyless if it fails).
    try {
      const ref = await secrets.set("llm", "legacy-ai", "apiKey", nextAi.apiKey);
      nextAi = { ...nextAi, apiKey: ref };
    } catch {
      nextAi = { ...nextAi, apiKey: "" };
    }
    changed = true;
  }

  // 3. Coding agent top-level key (shares the provider list, but may carry its
  //    own legacy raw key / its active provider's ref).
  let nextAgent = agent;
  const activeAgent = migratedProviders.find((p) => p.id === agent.activeProviderId);
  if (activeAgent) {
    if (agent.apiKey !== activeAgent.apiKey) {
      nextAgent = { ...agent, apiKey: activeAgent.apiKey };
      changed = true;
    }
  } else if (agent.apiKey && !isKeyRef(agent.apiKey)) {
    try {
      const ref = await secrets.set("llm", "legacy-agent", "apiKey", agent.apiKey);
      nextAgent = { ...agent, apiKey: ref };
    } catch {
      nextAgent = { ...agent, apiKey: "" };
    }
    changed = true;
  }

  return { ai: nextAi, agent: nextAgent, changed };
}


/** Reasoning effort for reasoning-capable models. "auto" = send NO override (use
 *  the model/provider default) — distinct from "off" (explicitly disable thinking).
 *  low/medium/high are universally supported. A real string (not undefined) so it
 *  round-trips through JSON persistence. */
export type ReasoningEffort = "auto" | "off" | "low" | "medium" | "high";

export interface AIConfig {
  /** The AI provider shape. All providers (cloud or user-run local servers
   *  like Ollama / LM Studio) are plain OpenAI-compatible connections. */
  provider?: "openai";
  /** Base URL for the OpenAI-compatible chat completions endpoint */
  baseUrl: string;
  /** Model name — any string accepted by the endpoint */
  model: string;
  /** API key. Empty string means "use server-side OPENAI_API_KEY env var" */
  apiKey: string;
  /** Maximum tool-call rounds per chat message. Lower = fewer API calls = lower cost. */
  maxSteps: number;
  /**
   * LLM sampling temperature (0–1). Absent = Auto: the request OMITS the field so
   * the model's own default applies (and it's never sent to models that declare
   * `temperature: false`). Lower = more deterministic.
   */
  temperature?: number;
  /** Context window size in tokens. Used to render the context usage ring. */
  contextLimit: number;
  /**
   * When true, `contextLimit` tracks the models.dev-detected value for the
   * current model automatically. Turned off the moment the user sets a manual
   * value (custom input or preset). Defaults to true.
   */
  contextAuto?: boolean;
  /**
   * Max output (completion) tokens to request per reply. When `maxOutputAuto`
   * is true this is ignored and the value is resolved from the model's
   * models.dev `limit.output` (bounded). A manual value lets power users pin a
   * ceiling — important for "thinking" models, whose reasoning counts against
   * this budget, so too small a value yields an empty reply. Defaults to Auto.
   */
  maxOutputTokens?: number;
  /** When true, max output tokens auto-resolves from the catalog. Defaults to true. */
  maxOutputAuto?: boolean;
  /** When false, all in-app AI features are hidden/disabled. Defaults to true. */
  aiEnabled: boolean;
  /**
   * Route chat through the dispatch → research/write subagent architecture.
   * Global preference. Ignored on the on-device Llama provider (small models are
   * unreliable with the multi-hop split).
   */
  subagentsEnabled: boolean;
  /**
   * Saved cloud/local API connections the user can switch between. This list is
   * the single, SHARED source of truth — the coding agent picks from the same
   * list (it only tracks its own `activeProviderId` on `agentConfig`). The
   * active one's baseUrl/apiKey/model are mirrored into the top-level fields
   * above so every existing consumer keeps working unchanged.
   */
  savedProviders?: SavedProvider[];
  /** Id of the AI Chat's active saved provider (matches an entry in `savedProviders`). */
  activeProviderId?: string;
  /**
   * Installed chat personalities (community + custom). The active one is
   * `personalityId` (absent/"" = Default — the base Cairn assistant with no
   * personality layer). Selection is global like the model picker it sits next
   * to.
   */
  installedPersonalities?: InstalledPersonality[];
  /** Id of the AI Chat's active personality (matches an entry in `installedPersonalities`).
   *  `null` = explicitly "None" — must survive hydration, so it is persisted as
   *  null (JSON + the backend cache) rather than dropped as undefined. */
  personalityId?: string | null;
  /**
   * Reasoning effort for reasoning-capable models (models.dev `reasoning: true`).
   * Controls how much the model "thinks" before answering — chat defaults to a
   * lower budget so everyday replies aren't dominated by long thinking traces
   * (deepseek-v4-flash defaults to high effort otherwise). Absent = the model's
   * own default. Only sent for reasoning-capable models.
   */
  reasoningEffort?: ReasoningEffort;
}

export interface AgentConfig {
  /** Base URL for the OpenAI-compatible chat completions endpoint */
  baseUrl: string;
  /** Model name — any string accepted by the endpoint */
  model: string;
  /** API key. Empty string means "use server-side OPENAI_API_KEY env var" */
  apiKey: string;
  /** Maximum tool-call rounds per chat message. */
  maxSteps: number;
  /**
   * LLM sampling temperature (0–1). Absent = Auto: the request OMITS the field so
   * the model's own default applies (and it's never sent to models that declare
   * `temperature: false`). Plan mode always uses 0.1 regardless.
   */
  temperature?: number;
  /** Context window size in tokens. Used to render the context usage ring. */
  contextLimit: number;
  /**
   * When true, `contextLimit` tracks the models.dev-detected value for the
   * current model automatically. Turned off the moment the user sets a manual
   * value (custom input or preset). Defaults to true.
   */
  contextAuto?: boolean;
  /**
   * Max output tokens per turn. When `maxOutputAuto` is true (default) this is
   * ignored and a generous Auto cap is sent — bounded by the model's declared
   * output limit, defaulting to 32K — so the model can finish naturally without
   * hitting a tiny endpoint default. A manual value is a deliberate
   * cost/latency ceiling.
   */
  maxOutputTokens?: number;
  /** When true, the Auto cap is used. Defaults to true. */
  maxOutputAuto?: boolean;
  /** Automatically approve tool execution without prompt. @deprecated — use `mode`. Kept as alias: true→"auto", false→"interactive". */
  autoApprove: boolean;
  /** OpenWorker-style approval Mode. When set it takes precedence over autoApprove. */
  mode?: import("../../../shared/agent/approval-mode").Mode;
  /**
   * Id of the active saved provider for the coding agent. The saved-provider
   * *list* is shared and lives on `aiConfig.savedProviders` (single source of
   * truth); the agent only tracks which one it has selected. The active
   * provider's baseUrl/apiKey/model are mirrored into the fields above so every
   * existing consumer keeps working unchanged.
   */
  activeProviderId?: string;
  /**
   * Reasoning effort for reasoning-capable models (models.dev `reasoning: true`).
   * Absent = the model's own default (the coding agent generally wants the full
   * thinking budget, so leaving this unset is fine). Only sent for
   * reasoning-capable models.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Opt-in dsh session reminders (`schedule_create`/`schedule_list`/
   * `schedule_delete` tools + header alarm pill). Read once at Cordis
   * bootstrap to gate the schedule overlay mount — toggling needs an app
   * restart. Default OFF. Explicitly NOT Cairn's own heartbeat.
   */
  scheduleEnabled?: boolean;
}

// ── Slice interface ───────────────────────────────────────────────────────────

export interface AiConfigSlice {
  // AI config
  aiConfig: AIConfig;
  setAIConfig: (patch: Partial<AIConfig>) => void;

  // Saved cloud/local API providers — one SHARED list (on aiConfig), with a
  // per-config active selection. add/update/delete mutate the shared list and
  // reconcile both configs; select* choose the active provider for one config.
  addSavedProvider: (provider: Omit<SavedProvider, "id">, selectFor?: "ai" | "agent" | "both") => string;
  updateSavedProvider: (id: string, patch: Partial<Omit<SavedProvider, "id">>) => void;
  deleteSavedProvider: (id: string) => void;
  selectSavedProvider: (id: string) => void;
  selectAgentProvider: (id: string) => void;
  /**
   * Ensure the shared saved-provider list contains a row for a raw
   * connection (baseUrl/model/apiKey) and select it. Reuses the existing
   * row when the normalized baseUrl already matches (patching an empty row
   * model from the connection first, so selecting never clobbers the
   * surface's current model with a stale default). Used by the retired-slug
   * migration and onboarding so the picker shows a real provider instead of
   * "Not configured". Returns the provider id. Skipped when baseUrl is blank.
   */
  ensureSavedProviderForConnection: (
    conn: { baseUrl: string; model: string; apiKey: string },
    selectFor?: "ai" | "agent" | "both",
  ) => string | null;
  /**
   * Install (or update) a community provider preset into the shared list and
   * store its API key in the OS keychain. Dedups by communityId (or name) so a
   * re-install reuses the existing row and its keychain secret. Does NOT auto-
   * select the provider for any surface — the user picks it in the switcher.
   * Returns the provider id.
   */
  installCommunityProvider: (
    entry: { id: string; definition: { name: string; baseUrl: string; defaultModel?: string } },
    apiKey?: string,
  ) => Promise<string>;

  // Chat personalities — a global installed list + active selection on aiConfig.
  /** Set (or clear, with null) the active chat personality. */
  setPersonality: (id: string | null) => void;
  /**
   * Install (or update) a community personality from the catalog into the
   * installed list. Dedups by communityId (or name). Does NOT auto-select.
   * Returns the installed personality id.
   */
  installCommunityPersonality: (entry: {
    id: string;
    author?: string;
    version?: string;
    brandColor?: string;
    homepage?: string;
    definition: { name: string; description?: string; prompt: string };
  }) => Promise<string>;
  /** Remove an installed personality; clears the active selection if it was active. */
  removePersonality: (id: string) => void;
  /** Create a local (custom) personality. Returns the new id. */
  createCustomPersonality: (input: { name: string; description?: string; prompt: string }) => string;

  // Agent config
  agentConfig: AgentConfig;
  setAgentConfig: (patch: Partial<AgentConfig>) => void;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

export const createAiConfigSlice: StateCreator<CairnStore, [], [], AiConfigSlice> = (
  set,
  get
) => ({
  aiConfig: DEFAULT_AI_CONFIG,
  agentConfig: DEFAULT_AGENT_CONFIG,

  // ── AI config ──────────────────────────────────
  setAIConfig(patch) {
    set((s) => {
      const next = { ...s.aiConfig, ...patch };
      persistAi(next);
      return { aiConfig: next };
    });
  },

  // ── Saved cloud/local API providers (shared list, per-config active) ───
  //
  // The provider LIST is a single shared source of truth on aiConfig; both the
  // AI Chat and the coding agent pick from it, each keeping its own
  // activeProviderId. add/update/delete mutate the list and reconcile BOTH
  // configs; select*/persistence write only the touched config(s).
  addSavedProvider(provider, selectFor = "ai") {
    const id = genId();
    set((s) => {
      const list = dedupeProviders([...(s.aiConfig.savedProviders ?? []), { id, ...provider }]);
      const added: SavedProvider = { id, ...provider };
      // AI config always owns the list; select it there when asked.
      const nextAi: AIConfig =
        selectFor === "ai" || selectFor === "both"
          ? { ...mirrorProvider(s.aiConfig, added), savedProviders: list }
          : { ...s.aiConfig, savedProviders: list };
      const nextAgent: AgentConfig =
        selectFor === "agent" || selectFor === "both"
          ? mirrorProvider(s.agentConfig, added)
          : s.agentConfig;
      persistAi(nextAi);
      if (nextAgent !== s.agentConfig) persistAgent(nextAgent);
      return { aiConfig: nextAi, agentConfig: nextAgent };
    });
    return id;
  },

  updateSavedProvider(id, patch) {
    set((s) => {
      const list = dedupeProviders(
        (s.aiConfig.savedProviders ?? []).map((p) => (p.id === id ? { ...p, ...patch } : p)),
      );
      // Re-mirror into whichever config(s) have this provider active.
      const nextAi: AIConfig = { ...reconcileConfig(s.aiConfig, list), savedProviders: list };
      const nextAgent: AgentConfig = reconcileConfig(s.agentConfig, list);
      persistAi(nextAi);
      if (nextAgent !== s.agentConfig) persistAgent(nextAgent);
      return { aiConfig: nextAi, agentConfig: nextAgent };
    });
  },

  deleteSavedProvider(id) {
    set((s) => {
      const list = dedupeProviders((s.aiConfig.savedProviders ?? []).filter((p) => p.id !== id));
      const nextAi: AIConfig = { ...reconcileConfig(s.aiConfig, list), savedProviders: list };
      const nextAgent: AgentConfig = reconcileConfig(s.agentConfig, list);
      persistAi(nextAi);
      if (nextAgent !== s.agentConfig) persistAgent(nextAgent);
      return { aiConfig: nextAi, agentConfig: nextAgent };
    });
  },

  selectSavedProvider(id) {
    set((s) => {
      const p = (s.aiConfig.savedProviders ?? []).find((x) => x.id === id);
      if (!p) return {};
      // Switching provider seeds the model from the provider default; re-selecting
      // the current provider keeps the surface's chosen model.
      const nextAi = s.aiConfig.activeProviderId === id
        ? syncConnection(s.aiConfig, p)
        : mirrorProvider(s.aiConfig, p);
      persistAi(nextAi);
      return { aiConfig: nextAi };
    });
  },

  selectAgentProvider(id) {
    set((s) => {
      // The list lives on aiConfig; read it there.
      const p = (s.aiConfig.savedProviders ?? []).find((x) => x.id === id);
      if (!p) return {};
      const nextAgent = s.agentConfig.activeProviderId === id
        ? syncConnection(s.agentConfig, p)
        : mirrorProvider(s.agentConfig, p);
      persistAgent(nextAgent);
      return { agentConfig: nextAgent };
    });
  },

  ensureSavedProviderForConnection(conn, selectFor = "ai") {
    if (!conn.baseUrl.trim()) return null;
    const norm = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
    const list = get().aiConfig.savedProviders ?? [];
    const existing = list.find((p) => norm(p.baseUrl) === norm(conn.baseUrl));
    if (existing) {
      if (!existing.model && conn.model) get().updateSavedProvider(existing.id, { model: conn.model });
      if (selectFor === "ai" || selectFor === "both") get().selectSavedProvider(existing.id);
      if (selectFor === "agent" || selectFor === "both") get().selectAgentProvider(existing.id);
      return existing.id;
    }
    let name = "Custom endpoint";
    try {
      const u = new URL(conn.baseUrl);
      const host = u.hostname.toLowerCase();
      name = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1"
        ? `Local server (${u.port || "default port"})`
        : host;
    } catch { /* keep fallback */ }
    return get().addSavedProvider(
      { name, baseUrl: conn.baseUrl, model: conn.model, apiKey: conn.apiKey },
      selectFor,
    );
  },

  async installCommunityProvider(entry, apiKey) {
    const def = entry.definition;
    const existing = (get().aiConfig.savedProviders ?? []).find(
      (p) => (p.communityId && p.communityId === entry.id) || p.name === def.name,
    );

    // Reuse the existing row's id on re-install so its keychain secret survives.
    const id = existing?.id ?? genId();

    // Store the raw API key in the OS keychain (main process) and keep only the
    // returned reference token — the raw key must NEVER land in the store.
    let apiKeyRef = existing?.apiKey ?? "";
    const raw = apiKey?.trim();
    if (raw) {
      const secrets = typeof window !== "undefined" ? window.electron?.secrets : undefined;
      if (!secrets) {
        // Refuse to persist a plaintext key when secure storage is unavailable
        // (e.g. a web build with no keychain bridge). Fail loudly instead.
        throw new Error("Secure storage unavailable — cannot store the API key.");
      }
      apiKeyRef = (await secrets.set("llm", id, "apiKey", raw)) ?? "";
    }

    set((s) => {
      const prev = s.aiConfig.savedProviders ?? [];
      // Re-resolve the target row against the LATEST state inside the commit so
      // two racing installs of the same entry collapse to a single row (dedup by
      // communityId / name), preserving the keychain reference resolved above.
      const matchIdx = prev.findIndex(
        (p) => p.id === id || (p.communityId && p.communityId === entry.id) || p.name === def.name,
      );
      const row: SavedProvider = {
        id: matchIdx >= 0 ? prev[matchIdx].id : id,
        name: def.name,
        baseUrl: def.baseUrl,
        model: def.defaultModel ?? (matchIdx >= 0 ? prev[matchIdx].model : existing?.model) ?? "",
        apiKey: apiKeyRef || (matchIdx >= 0 ? prev[matchIdx].apiKey : ""),
        source: "community",
        communityId: entry.id,
      };
      const merged =
        matchIdx >= 0 ? prev.map((p, i) => (i === matchIdx ? row : p)) : [...prev, row];
      const list = dedupeProviders(merged);
      // Do NOT auto-select — reconcile keeps each surface's active choice.
      const nextAi: AIConfig = { ...reconcileConfig(s.aiConfig, list), savedProviders: list };
      const nextAgent: AgentConfig = reconcileConfig(s.agentConfig, list);
      persistAi(nextAi);
      if (nextAgent !== s.agentConfig) persistAgent(nextAgent);
      return { aiConfig: nextAi, agentConfig: nextAgent };
    });

    return id;
  },

  // ── Chat personalities ──────────────────────────
  setPersonality(id) {
    set((s) => {
      // Preserve `null` (explicit "None") — persisting it as null (not
      // undefined) lets the backend cache clear its value instead of keeping
      // the previous selection and resurrecting it on the next hydrate.
      const next = { ...s.aiConfig, personalityId: id };
      persistAi(next);
      return { aiConfig: next };
    });
  },

  async installCommunityPersonality(entry) {
    const def = entry.definition;
    const nameMatch = (p: InstalledPersonality) => p.name.toLowerCase() === def.name.toLowerCase();
    const existing = (get().aiConfig.installedPersonalities ?? []).find(
      // Name-based dedup only matches rows that CAME from the catalog — a
      // custom personality with the same name must never be replaced/upgraded
      // by a community install (its prompt would be lost, source flipped).
      (p) => p.communityId === entry.id || (p.source === "community" && nameMatch(p)),
    );
    // Reuse the existing row's id on re-install (dedup by communityId, or by
    // name for prior community rows).
    const id = existing?.id ?? genId();
    set((s) => {
      const prev = s.aiConfig.installedPersonalities ?? [];
      const matchIdx = prev.findIndex(
        (p) => p.id === id || p.communityId === entry.id || (p.source === "community" && nameMatch(p)),
      );
      const row: InstalledPersonality = {
        id: matchIdx >= 0 ? prev[matchIdx].id : id,
        name: def.name,
        description: def.description,
        prompt: def.prompt,
        source: "community",
        communityId: entry.id,
        version: entry.version,
        author: entry.author,
        brandColor: entry.brandColor,
        homepage: entry.homepage,
      };
      const merged = matchIdx >= 0 ? prev.map((p, i) => (i === matchIdx ? row : p)) : [...prev, row];
      const nextAi: AIConfig = { ...s.aiConfig, installedPersonalities: merged };
      persistAi(nextAi);
      return { aiConfig: nextAi };
    });
    return id;
  },

  removePersonality(id) {
    set((s) => {
      const list = (s.aiConfig.installedPersonalities ?? []).filter((p) => p.id !== id);
      const nextAi: AIConfig = {
        ...s.aiConfig,
        installedPersonalities: list,
        ...(s.aiConfig.personalityId === id ? { personalityId: null } : {}),
      };
      persistAi(nextAi);
      return { aiConfig: nextAi };
    });
  },

  createCustomPersonality(input) {
    const id = genId();
    set((s) => {
      const row: InstalledPersonality = {
        id,
        name: input.name,
        description: input.description,
        prompt: input.prompt,
        source: "custom",
      };
      const nextAi: AIConfig = {
        ...s.aiConfig,
        installedPersonalities: [...(s.aiConfig.installedPersonalities ?? []), row],
      };
      persistAi(nextAi);
      return { aiConfig: nextAi };
    });
    return id;
  },

  // ── Agent config ───────────────────────────────
  setAgentConfig(patch) {
    set((s) => {
      const next = { ...s.agentConfig, ...patch } as typeof s.agentConfig & { mode?: import("../../../shared/agent/approval-mode").Mode };
      // Keep mode ↔ autoApprove in sync so old readers (main cache, legacy UI)
      // and new readers (mode-aware gate) agree. Patch may carry either shape.
      const hasMode = "mode" in patch && (patch as { mode?: unknown }).mode !== undefined;
      const hasAuto = "autoApprove" in patch && (patch as { autoApprove?: unknown }).autoApprove !== undefined;
      if (hasMode && !hasAuto) {
        const m = (patch as { mode?: import("../../../shared/agent/approval-mode").Mode }).mode;
        next.autoApprove = m === "auto";
      } else if (hasAuto && !hasMode) {
        const a = (patch as { autoApprove?: boolean }).autoApprove;
        next.mode = a ? "auto" : "interactive";
      } else if (hasMode && hasAuto) {
        // both supplied — keep as-is (caller is authoritative)
      }
      persistAgent(next);
      return { agentConfig: next as typeof s.agentConfig };
    });
  },
});
