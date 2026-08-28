import fs from "fs";
import path from "path";
import { findUserDataDir } from "../runtime/port-discovery";
import { resolveMaxOutputTokens } from "../../shared/models/model-catalog";

const CONFIG_CACHE_FILE = "ai-settings-cache.json";

export interface CachedEmbeddingsConfig {
  enabled?: boolean;
  modelId?: string;
}

export interface CachedConfig {
  aiConfig?: {
    provider?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    // Persist the FULL renderer AIConfig, not just connection fields. Dropping
    // these here caused hydrateFromElectron() to reset them to DEFAULT_AI_CONFIG
    // after every write-tool turn — e.g. the chat tool-call limit (maxSteps)
    // silently "reverted to 30" mid-conversation.
    maxSteps?: number;
    temperature?: number;
    contextLimit?: number;
    aiEnabled?: boolean;
    subagentsEnabled?: boolean;
    /** @deprecated — engine is now always cordis; this field is ignored. Remove in Phase 2. */
    engine?: "builtin" | "cordis";
    // Max output tokens: Auto (default) sends a generous 32K cap (bounded by the
    // model's declared output limit) so the model can finish naturally; a manual
    // value is a deliberate cap. Persisted so main-process consumers (e.g. the
    // tool builder) honour the same Auto semantics as the chat/agent loops.
    maxOutputAuto?: boolean;
    maxOutputTokens?: number;
    /** Reasoning effort for reasoning-capable models ("off"|"low"|"medium"|"high"). */
    reasoningEffort?: string;
    /** Explicit wire protocol ("responses"|"completions"|"anthropic-messages"). */
    apiMode?: string;
    // Saved cloud/local API connections the user can switch between, plus the
    // id of the active one. Persisted so the switcher survives restarts.
    savedProviders?: Array<{ id: string; name: string; baseUrl: string; apiKey: string; model: string; apiMode?: string }>;
    activeProviderId?: string;
    // Installed chat personalities (community + custom) and the active one.
    // Persisted so the picker + selection survive restarts; the personality
    // text is plain (no secrets), so it is cached verbatim.
    installedPersonalities?: Array<{
      id: string;
      name: string;
      description?: string;
      prompt: string;
      source: "community" | "custom";
      communityId?: string;
      version?: string;
      author?: string;
      brandColor?: string;
      homepage?: string;
    }>;
    /** Active personality id. `null` (explicit "None") is stored as absent. */
    personalityId?: string | null;
  };
  agentConfig?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    maxSteps?: number;
    temperature?: number;
    maxTokens?: number;
    autoApprove?: boolean;
    // The coding agent's active saved-provider id. The provider LIST itself is
    // shared and persisted under aiConfig.savedProviders (single source of truth).
    activeProviderId?: string;
  };
  embeddingsConfig?: CachedEmbeddingsConfig;
  theme?: string;
  fontScale?: number;
}

function getCachePath(): string {
  // Resolve the userData dir WITHOUT a static `electron` import so this module
  // can also load in the standalone MCP runtime (pkg/Node, no working `electron`
  // module — importing it throws "Electron failed to install correctly"). In the
  // Electron main process, `app.getPath("userData")` is authoritative; elsewhere
  // (MCP server, tests before app-ready) fall back to the filesystem scan that
  // mirrors mcp/db.ts. Both point at the same on-disk cache file.
  let userData = "";
  try {
    // Lazy, defensive require: `electron` resolves to a real module only inside
    // the Electron process; in the MCP runtime the require itself throws, so we
    // swallow it and fall back below.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as { app?: Electron.App };
    if (electron.app && electron.app.isReady()) {
      userData = electron.app.getPath("userData");
    }
  } catch {
    // Not running under Electron (MCP runtime / tests) — fall through to scan.
  }
  if (!userData) {
    userData = findUserDataDir() ?? "";
  }
  if (!userData) return "";
  return path.join(userData, CONFIG_CACHE_FILE);
}

/**
 * Persist only max-output-token values the consumers would actually honour.
 * `resolveMaxOutputTokens` floors fractional caps and rejects <1 (which would
 * floor to a broken `max_tokens: 0`); any candidate it rejects falls back to
 * the existing cached value instead of being stored verbatim.
 */
function normalizeMaxOutputTokens(
  candidate: unknown,
  current: number | undefined,
): number | undefined {
  const resolved = resolveMaxOutputTokens(typeof candidate === "number" ? candidate : null);
  return resolved ?? current;
}

export function saveCachedConfig(type: "ai" | "agent" | "embeddings" | "theme" | "fontScale", config: unknown): void {
  try {
    const filePath = getCachePath();
    if (!filePath) return;
    
    let current: CachedConfig = {};
    if (fs.existsSync(filePath)) {
      try {
        current = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch {
        // Ignore corrupt cache
      }
    }
    
    // Type-guard/assert type safe access
    const configRecord = config as Record<string, string | number | boolean | undefined> | null | undefined;

    // Only keychain reference tokens (`secret://…`) may be cached for an apiKey —
    // never a raw key. Resolve the cached value for an incoming apiKey field:
    //   - field absent            → keep the current cached value
    //   - a `secret://…` ref      → store the ref
    //   - anything else (incl "") → store "" (explicit clear; never a raw key)
    // (Local check rather than importing secure-store's isSecretRef, which pulls
    // in `electron` and would break the MCP runtime that also loads this module.)
    const isRef = (v: unknown): v is string => typeof v === "string" && v.startsWith("secret://");
    const resolveCachedKey = (incoming: unknown, current: string | undefined): string | undefined => {
      if (!("apiKey" in (configRecord as object))) return current; // omitted → preserve
      return isRef(incoming) ? incoming : "";                       // ref kept, else cleared
    };

    if (type === "ai" && configRecord) {
      current.aiConfig = {
        ...current.aiConfig,
        provider: typeof configRecord.provider === "string" ? configRecord.provider : current.aiConfig?.provider,
        baseUrl: typeof configRecord.baseUrl === "string" ? configRecord.baseUrl : current.aiConfig?.baseUrl,
        model: typeof configRecord.model === "string" ? configRecord.model : current.aiConfig?.model,
        apiKey: resolveCachedKey(configRecord.apiKey, current.aiConfig?.apiKey),
        // Preserve behavioural fields too — omitting maxSteps here made the chat
        // tool-call limit reset to the default on the next hydrate.
        maxSteps: typeof configRecord.maxSteps === "number" ? configRecord.maxSteps : current.aiConfig?.maxSteps,
        temperature: typeof configRecord.temperature === "number" ? configRecord.temperature : current.aiConfig?.temperature,
        contextLimit: typeof configRecord.contextLimit === "number" ? configRecord.contextLimit : current.aiConfig?.contextLimit,
        aiEnabled: typeof configRecord.aiEnabled === "boolean" ? configRecord.aiEnabled : current.aiConfig?.aiEnabled,
        subagentsEnabled: typeof configRecord.subagentsEnabled === "boolean" ? configRecord.subagentsEnabled : current.aiConfig?.subagentsEnabled,
        engine: configRecord.engine === "cordis" || configRecord.engine === "builtin" ? configRecord.engine : current.aiConfig?.engine,
        maxOutputAuto: typeof configRecord.maxOutputAuto === "boolean" ? configRecord.maxOutputAuto : current.aiConfig?.maxOutputAuto,
        // Normalize the candidate through the same helper consumers use: only a
        // value resolveMaxOutputTokens honours (>= 1, floored) is persisted; an
        // invalid candidate (Auto sentinel, <1, fractional-down-to-0) preserves
        // the existing cached value rather than storing one that would be
        // silently ignored on read. maxOutputAuto is deliberately untouched.
        maxOutputTokens: normalizeMaxOutputTokens(configRecord.maxOutputTokens, current.aiConfig?.maxOutputTokens),
        // Reasoning effort + explicit API protocol must round-trip too, or they
        // revert to their defaults on the next hydrate (backend cache is layered
        // OVER localStorage). "off"|"low"|"medium"|"high" and the ApiMode strings.
        reasoningEffort: typeof configRecord.reasoningEffort === "string" ? configRecord.reasoningEffort : current.aiConfig?.reasoningEffort,
        apiMode: typeof configRecord.apiMode === "string" ? configRecord.apiMode : current.aiConfig?.apiMode,
        // Saved-provider switcher state (array + active id). Each provider's
        // apiKey is scrubbed to a ref (or dropped) so no raw key is cached.
        savedProviders: Array.isArray((config as { savedProviders?: unknown }).savedProviders)
          ? (config as { savedProviders: NonNullable<CachedConfig["aiConfig"]>["savedProviders"] }).savedProviders!.map(
              (p) => ({ ...p, apiKey: isRef(p.apiKey) ? p.apiKey : "" }),
            )
          : current.aiConfig?.savedProviders,
        activeProviderId: typeof configRecord.activeProviderId === "string" ? configRecord.activeProviderId : current.aiConfig?.activeProviderId,
        // Installed personalities + active selection. The prompt text is plain
        // (never a secret), so it is stored verbatim like savedProviders.
        installedPersonalities: Array.isArray((config as { installedPersonalities?: unknown }).installedPersonalities)
          ? (config as { installedPersonalities: NonNullable<CachedConfig["aiConfig"]>["installedPersonalities"] }).installedPersonalities
          : current.aiConfig?.installedPersonalities,
        // personalityId: a string is stored; an explicit null (the renderer's
        // "None" choice) CLEARS the cached value instead of keeping the old one
        // (which would resurrect the previous personality on the next hydrate).
        // Absent (a connection-only save) preserves the current value.
        personalityId: configRecord.personalityId === null
          ? undefined
          : typeof configRecord.personalityId === "string"
            ? configRecord.personalityId
            : current.aiConfig?.personalityId,
      };
    } else if (type === "agent" && configRecord) {
      current.agentConfig = {
        ...current.agentConfig,
        baseUrl: typeof configRecord.baseUrl === "string" ? configRecord.baseUrl : current.agentConfig?.baseUrl,
        model: typeof configRecord.model === "string" ? configRecord.model : current.agentConfig?.model,
        apiKey: resolveCachedKey(configRecord.apiKey, current.agentConfig?.apiKey),
        maxSteps: typeof configRecord.maxSteps === "number" ? configRecord.maxSteps : current.agentConfig?.maxSteps,
        temperature: typeof configRecord.temperature === "number" ? configRecord.temperature : current.agentConfig?.temperature,
        maxTokens: typeof configRecord.maxTokens === "number" ? configRecord.maxTokens : current.agentConfig?.maxTokens,
        autoApprove: typeof configRecord.autoApprove === "boolean" ? configRecord.autoApprove : current.agentConfig?.autoApprove,
        activeProviderId: typeof configRecord.activeProviderId === "string" ? configRecord.activeProviderId : current.agentConfig?.activeProviderId,
      };
    } else if (type === "embeddings" && configRecord) {
      current.embeddingsConfig = {
        ...current.embeddingsConfig,
        enabled: typeof configRecord.enabled === "boolean" ? configRecord.enabled : current.embeddingsConfig?.enabled,
        modelId: typeof configRecord.modelId === "string" ? configRecord.modelId : current.embeddingsConfig?.modelId,
      };
    } else if (type === "theme") {
      current.theme = String(config);
    } else if (type === "fontScale") {
      current.fontScale = Number(config);
    }
    
    fs.writeFileSync(filePath, JSON.stringify(current, null, 2), "utf-8");
  } catch (err) {
    console.error("[config-cache] Failed to save config:", err);
  }
}

export function getCachedConfig(): CachedConfig {
  try {
    const filePath = getCachePath();
    if (filePath && fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (err) {
    console.error("[config-cache] Failed to read config:", err);
  }
  return {};
}

export function getEmbeddingsSettingsCached(): CachedEmbeddingsConfig {
  return getCachedConfig().embeddingsConfig ?? {};
}

/**
 * Persist an LLM connection to the cache from an IPC request config. Shared by
 * the chat / prd / flow / session handlers so the "cache only a keychain ref,
 * never a raw key" rule lives in one place. `saveCachedConfig` scrubs the apiKey
 * (a non-ref value is stored as an explicit clear), so callers can pass the
 * request config straight through without their own guard.
 */
export function cacheLlmConnection(
  type: "ai" | "agent",
  config: { provider?: string; baseUrl?: string; model?: string; apiKey?: string; maxSteps?: number; temperature?: number; maxTokens?: number; autoApprove?: boolean } | undefined,
): void {
  if (!config) return;
  if (config.baseUrl === undefined && config.model === undefined && config.apiKey === undefined) return;
  saveCachedConfig(type, config);
}

