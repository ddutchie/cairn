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
  };
  theme?: string;
  fontScale?: number;
}

function getCachePath(): string {
  // Fallback if app is not yet initialised in tests
  const userData = app ? app.getPath("userData") : "";
  return path.join(userData, CONFIG_CACHE_FILE);
}

export function saveCachedConfig(type: "ai" | "agent" | "theme" | "fontScale", config: any): void {
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
    
    if (type === "ai") {
      current.aiConfig = {
        ...current.aiConfig,
        provider: config.provider || current.aiConfig?.provider,
        baseUrl: config.baseUrl || current.aiConfig?.baseUrl,
        model: config.model || current.aiConfig?.model,
        apiKey: config.apiKey || current.aiConfig?.apiKey,
      };
    } else if (type === "agent") {
      current.agentConfig = {
        ...current.agentConfig,
        baseUrl: config.baseUrl || current.agentConfig?.baseUrl,
        model: config.model || current.agentConfig?.model,
        apiKey: config.apiKey || current.agentConfig?.apiKey,
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
