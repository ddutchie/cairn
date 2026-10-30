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
    /** List engine registry commands (name + description) — palette source. */
    listCommands: (req: { cwd?: string } = {}) => invokeContract("commands:list", req),
    /** Execute a engine registry command (/plan, /compact, …) on a session's agent. */
    executeCommand: (req: { sessionId: string; line: string }) => invokeContract("commands:execute", req),
    /** Assemble the real engine system prompt (engine) + breakdown. */
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
} as const;
