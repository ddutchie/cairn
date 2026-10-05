/** Unified runtime, Mobile Access and UI plugins. */

import { invokeContract, onIpcEvent } from "./ipc";
import type { EmbeddingDownloadProgress } from "../../shared/types/embeddings";
import type { MobileStatus } from "../../shared/types/runtime";

export const runtimeApi = {
  // ── Unified Runtime (local embeddings for semantic search) ───────────
  // LLM inference is user-provided: point a saved provider at Ollama,
  // LM Studio, or any OpenAI-compatible local server.
  runtime: {
    status: () => invokeContract("runtime:status"),
    stop: () => invokeContract("runtime:stop"),
    /** List dsh registry commands (name + description) — palette source. */
    listCommands: () => invokeContract("cordis:listCommands"),
    /** Execute a dsh registry command (/plan, /compact, …) on a session's agent. */
    executeCommand: (req: { sessionId: string; line: string }) => invokeContract("cordis:executeCommand", req),
    /** Assemble the real dsh system prompt (Cordis engine) + breakdown. */
    systemPromptPreview: (req: { cwd?: string; projectName?: string }) =>
      invokeContract("runtime:systemPrompt:preview", req),
    /** The coding agent's plain-string system prompt (board-tracking workflow). */
    codingPromptPreview: (req: { cwd?: string; projectName?: string; taskTitle?: string }) =>
      invokeContract("runtime:codingPrompt:preview", req),
    /** Per-surface tool inventory (chat/coding/automation-dev/mcp + live global tools). */
    toolsInventory: () => invokeContract("runtime:tools:inventory"),
    onProgress: (cb: (e: EmbeddingDownloadProgress) => void) => onIpcEvent("runtime:download-progress", cb),
    embeddings: {
      status: () => invokeContract("runtime:embeddings:status"),
      ensureStarted: () => invokeContract("runtime:embeddings:ensureStarted"),
      models: () => invokeContract("runtime:embeddings:models"),
      install: (modelId: string) => invokeContract("runtime:embeddings:install", { modelId }),
      remove: (modelId: string) => invokeContract("runtime:embeddings:remove", { modelId }),
      setDefault: (modelId: string) => invokeContract("runtime:embeddings:setDefault", { modelId }),
      onProgress: (cb: (e: EmbeddingDownloadProgress) => void) => onIpcEvent("runtime:download-progress", cb),
    },
  },
  // ── Mobile Access ────────────────────────────────
  mobile: {
    status: () => invokeContract("mobile:status"),
    saveSettings: (newSettings: Record<string, unknown>) => invokeContract("mobile:saveSettings", newSettings),
    regeneratePin: () => invokeContract("mobile:regeneratePin"),
    onStatusChanged: (cb: (status: MobileStatus) => void) => onIpcEvent("mobile:status-changed", cb),
  },
  /** UI plugins (dev-gated): pull renderer-side plugin sources + live-change events. */
  plugins: {
    listUi: () => invokeContract("plugins:listUi"),
    onUiChanged: (cb: () => void) => onIpcEvent("plugins:ui-changed", cb),
    /** Settings section: full manifest (enabled + disabled), toggle, open folder. */
    list: () => invokeContract("plugins:list"),
    setEnabled: (id: string, enabled: boolean) => invokeContract("plugins:setEnabled", { id, enabled }),
    openFolder: () => invokeContract("plugins:openFolder"),
    /** Install from a spec (github:owner/repo | owner/repo | local path). Dev-gated. */
    install: (spec: string) => invokeContract("plugins:install", { spec }),
    /** Update an installed plugin by re-running its recorded source spec. Dev-gated. */
    update: (id: string) => invokeContract("plugins:update", { id }),
    uninstall: (id: string) => invokeContract("plugins:uninstall", { id }),
  },
} as const;
