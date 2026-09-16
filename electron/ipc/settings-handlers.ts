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
import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

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
  registerIpcHandle("app:getFontScale", () => handle(() => getCachedConfig().fontScale ?? null));
  registerIpcHandle("app:saveFontScale", (_e, { fontScale }: { fontScale: number }) => handle(() => {
    saveCachedConfig("fontScale", fontScale);
    return { ok: true };
  }));
  registerIpcHandle("app:getEmbeddingsSettings", () => handle(() => getCachedConfig().embeddingsConfig ?? null));
  registerIpcHandle("app:saveEmbeddingsSettings", (_e, { config }: { config: Record<string, unknown> }) => handle(() => {
    saveCachedConfig("embeddings", config);
    return { ok: true };
  }));

  // ── Retired on-device engine leftovers ──────────────────────────────
  // Cairn no longer ships LLM inference, so GGUFs/binaries downloaded by
  // older builds sit orphaned under userData. Size probe + opt-in delete
  // (Settings → Data). Embeddings live elsewhere and are never touched.
  const llmLeftoverDirs = () => {
    const userData = app.getPath("userData");
    return [path.join(userData, "llama-models"), path.join(userData, "llama-bin")];
  };
  const walkSize = (dir: string, out: Array<{ name: string; bytes: number }>): number => {
    let total = 0;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) {
          total += walkSize(full, out);
        } else {
          const bytes = fs.statSync(full).size;
          total += bytes;
          out.push({ name: path.relative(path.join(app.getPath("userData")), full), bytes });
        }
      } catch { /* ignore unreadable entries */ }
    }
    return total;
  };
  registerIpcHandle("app:llmLeftovers", () => handle(() => {
    const files: Array<{ name: string; bytes: number }> = [];
    let bytes = 0;
    for (const dir of llmLeftoverDirs()) bytes += walkSize(dir, files);
    files.sort((a, b) => b.bytes - a.bytes);
    return { bytes, files };
  }));
  registerIpcHandle("app:clearLlmLeftovers", () => handle(() => {
    const files: Array<{ name: string; bytes: number }> = [];
    let bytes = 0;
    for (const dir of llmLeftoverDirs()) bytes += walkSize(dir, files);
    for (const dir of llmLeftoverDirs()) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
    return { reclaimedBytes: bytes };
  }));
}
