/**
 * Cairn — IPC handlers for the cached settings channels.
 *
 * `app:{get,save}{AiSettings,AgentSettings,Theme,FontScale}` — these mirror the
 * localStorage-persisted values on the renderer side; the cached copy here lives
 * in `userData/config-cache.json` (handled by `electron/lib/config-cache.ts`)
 * so a fresh launch can read AI/theme settings before any IPC round-trip.
 *
 * Extracted from the god-file `ipc/handlers.ts` (P2 of the cleanup plan).
 */

import { registerIpcHandle } from "./registry";
import { handle } from "./result-helpers";
import { saveCachedConfig, getCachedConfig } from "../lib/config-cache";

export function registerSettingsHandlers(): void {
  registerIpcHandle("app:getAiSettings", () => handle(() => getCachedConfig().aiConfig || null));
  registerIpcHandle("app:saveAiSettings", (_e, { config }: { config: Record<string, unknown> }) => handle(() => {
    saveCachedConfig("ai", config);
    return { ok: true };
  }));
  registerIpcHandle("app:getAgentSettings", () => handle(() => getCachedConfig().agentConfig || null));
  registerIpcHandle("app:saveAgentSettings", (_e, { config }: { config: Record<string, unknown> }) => handle(() => {
    saveCachedConfig("agent", config);
    return { ok: true };
  }));
  registerIpcHandle("app:getTheme", () => handle(() => getCachedConfig().theme || null));
  registerIpcHandle("app:saveTheme", (_e, { theme }: { theme: string }) => handle(() => {
    saveCachedConfig("theme", theme);
    return { ok: true };
  }));
  registerIpcHandle("app:getFontScale", () => handle(() => getCachedConfig().fontScale || null));
  registerIpcHandle("app:saveFontScale", (_e, { fontScale }: { fontScale: number }) => handle(() => {
    saveCachedConfig("fontScale", fontScale);
    return { ok: true };
  }));
}
