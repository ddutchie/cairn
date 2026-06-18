import { app } from "electron";
import fs from "fs";
import path from "path";

const CONFIG_CACHE_FILE = "ai-settings-cache.json";

export interface CachedConfig {
  aiConfig?: {
    provider?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  };
  agentConfig?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    maxSteps?: number;
    temperature?: number;
    autoApprove?: boolean;
  };
  theme?: string;
  fontScale?: number;
}

function getCachePath(): string {
  // Guard if app is not yet ready or running in tests
  if (!app || !app.isReady()) {
    return "";
  }
  const userData = app.getPath("userData");
  return path.join(userData, CONFIG_CACHE_FILE);
}

export function saveCachedConfig(type: "ai" | "agent" | "theme" | "fontScale", config: unknown): void {
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
      };
    } else if (type === "agent" && configRecord) {
      current.agentConfig = {
        ...current.agentConfig,
        baseUrl: typeof configRecord.baseUrl === "string" ? configRecord.baseUrl : current.agentConfig?.baseUrl,
        model: typeof configRecord.model === "string" ? configRecord.model : current.agentConfig?.model,
        apiKey: typeof configRecord.apiKey === "string" ? configRecord.apiKey : current.agentConfig?.apiKey,
        autoApprove: typeof configRecord.autoApprove === "boolean" ? configRecord.autoApprove : current.agentConfig?.autoApprove,
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
