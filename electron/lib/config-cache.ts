import fs from "fs";
import path from "path";
import { findUserDataDir } from "../runtime/port-discovery";

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
    // Saved cloud/local API connections the user can switch between, plus the
    // id of the active one. Persisted so the switcher survives restarts.
    savedProviders?: Array<{ id: string; name: string; baseUrl: string; apiKey: string; model: string }>;
    activeProviderId?: string;
  };
  agentConfig?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    maxSteps?: number;
    temperature?: number;
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
    
    if (type === "ai" && configRecord) {
      current.aiConfig = {
        ...current.aiConfig,
        provider: typeof configRecord.provider === "string" ? configRecord.provider : current.aiConfig?.provider,
        baseUrl: typeof configRecord.baseUrl === "string" ? configRecord.baseUrl : current.aiConfig?.baseUrl,
        model: typeof configRecord.model === "string" ? configRecord.model : current.aiConfig?.model,
        apiKey: typeof configRecord.apiKey === "string" ? configRecord.apiKey : current.aiConfig?.apiKey,
        // Preserve behavioural fields too — omitting maxSteps here made the chat
        // tool-call limit reset to the default on the next hydrate.
        maxSteps: typeof configRecord.maxSteps === "number" ? configRecord.maxSteps : current.aiConfig?.maxSteps,
        temperature: typeof configRecord.temperature === "number" ? configRecord.temperature : current.aiConfig?.temperature,
        contextLimit: typeof configRecord.contextLimit === "number" ? configRecord.contextLimit : current.aiConfig?.contextLimit,
        aiEnabled: typeof configRecord.aiEnabled === "boolean" ? configRecord.aiEnabled : current.aiConfig?.aiEnabled,
        subagentsEnabled: typeof configRecord.subagentsEnabled === "boolean" ? configRecord.subagentsEnabled : current.aiConfig?.subagentsEnabled,
        // Saved-provider switcher state (array + active id). `configRecord` is
        // typed for scalars, so read the raw config object for these.
        savedProviders: Array.isArray((config as { savedProviders?: unknown }).savedProviders)
          ? (config as { savedProviders: NonNullable<CachedConfig["aiConfig"]>["savedProviders"] }).savedProviders
          : current.aiConfig?.savedProviders,
        activeProviderId: typeof configRecord.activeProviderId === "string" ? configRecord.activeProviderId : current.aiConfig?.activeProviderId,
      };
    } else if (type === "agent" && configRecord) {
      current.agentConfig = {
        ...current.agentConfig,
        baseUrl: typeof configRecord.baseUrl === "string" ? configRecord.baseUrl : current.agentConfig?.baseUrl,
        model: typeof configRecord.model === "string" ? configRecord.model : current.agentConfig?.model,
        apiKey: typeof configRecord.apiKey === "string" ? configRecord.apiKey : current.agentConfig?.apiKey,
        maxSteps: typeof configRecord.maxSteps === "number" ? configRecord.maxSteps : current.agentConfig?.maxSteps,
        temperature: typeof configRecord.temperature === "number" ? configRecord.temperature : current.agentConfig?.temperature,
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
