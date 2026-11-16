/**
 * Typed clients for the unified runtime (`runtime:*`, `commands:*`,
 * `sandbox:*`) and the legacy embeddings worker (`embeddings:*`).
 * Every failure rejects with the main-process message; off-Electron calls
 * reject with `IpcUnavailableError`.
 *
 * NOTE: `runtime.embeddings` is the survivor (refactor plan Q1). The legacy
 * `embeddings:*` namespace below goes away with the old worker in B6.
 */
import type { EmbeddingDownloadProgress } from "../../../shared/types/embeddings";
import { domainCall, type ElectronApi } from "./client";

type RuntimeApi = NonNullable<ElectronApi["runtime"]>;
const runtime = <T>(fn: (api: RuntimeApi) => Promise<T>) => domainCall("runtime", fn);

export const runtimeClient = {
  status: () => runtime((r) => r.status()),
  stop: () => runtime((r) => r.stop()),
  /** List engine registry commands (name + description) — palette source. */
  listCommands: (req: { cwd?: string } = {}) => runtime((r) => r.listCommands(req)),
  /** Whether the shell sandbox is actually confining commands on this machine. */
  sandboxStatus: () => runtime((r) => r.sandboxStatus()),
  /** Execute an engine registry command (/plan, /compact, …) on a session's agent. */
  executeCommand: (req: { sessionId: string; line: string }) => runtime((r) => r.executeCommand(req)),
  /** Assemble the real engine system prompt (engine) + breakdown. */
  systemPromptPreview: (req: { cwd?: string; projectName?: string }) =>
    runtime((r) => r.systemPromptPreview(req)),
  /** The coding agent's plain-string system prompt (board-tracking workflow). */
  codingPromptPreview: (req: { cwd?: string; projectName?: string; taskTitle?: string }) =>
    runtime((r) => r.codingPromptPreview(req)),
  /** Per-surface tool inventory (chat/coding/automation-dev/mcp + live global tools). */
  toolsInventory: () => runtime((r) => r.toolsInventory()),
  /** Subscribe to runtime download progress; returns the unsubscribe function. */
  onProgress: (cb: (e: EmbeddingDownloadProgress) => void): (() => void) =>
    window.electron?.runtime?.onProgress?.(cb) ?? (() => {}),
  embeddings: {
    status: () => runtime((r) => r.embeddings.status()),
    ensureStarted: () => runtime((r) => r.embeddings.ensureStarted()),
    models: () => runtime((r) => r.embeddings.models()),
    install: (modelId: string) => runtime((r) => r.embeddings.install(modelId)),
    remove: (modelId: string) => runtime((r) => r.embeddings.remove(modelId)),
    setDefault: (modelId: string) => runtime((r) => r.embeddings.setDefault(modelId)),
    /** Subscribe to embedding download progress; returns the unsubscribe function. */
    onProgress: (cb: (e: EmbeddingDownloadProgress) => void): (() => void) =>
      window.electron?.runtime?.embeddings?.onProgress?.(cb) ?? (() => {}),
  },
};

type EmbeddingsApi = NonNullable<ElectronApi["embeddings"]>;
const embeddings = <T>(fn: (api: EmbeddingsApi) => Promise<T>) => domainCall("embeddings", fn);

/**
 * Legacy embeddings worker (`embeddings:*`, `db:embeddings:*`,
 * `app:*EmbeddingsSettings`). Do not extend — new code uses
 * `runtimeClient.embeddings`. Removed with the old worker in B6 (plan Q1).
 */
export const embeddingsClient = {
  status: () => embeddings((e) => e.status()),
  stop: () => embeddings((e) => e.stop()),
  needsReindex: () => embeddings((e) => e.needsReindex()),
  projections: (workspaceId: string) => embeddings((e) => e.projections(workspaceId)),
  reindex: (workspaceId: string, noteIds?: string[], model?: string) =>
    embeddings((e) => e.reindex(workspaceId, noteIds, model)),
  search: (
    workspaceId: string,
    queryText: string,
    opts?: { queryNoteId?: string; k?: number; excludeIds?: string[]; model?: string },
  ) => embeddings((e) => e.search(workspaceId, queryText, opts)),
  recomputeProjections: (workspaceId: string, model?: string) =>
    embeddings((e) => e.recomputeProjections(workspaceId, model)),
  models: {
    list: () => embeddings((e) => e.models.list()),
    install: (modelId: string) => embeddings((e) => e.models.install(modelId)),
    remove: (modelId: string) => embeddings((e) => e.models.remove(modelId)),
    setDefault: (modelId: string) => embeddings((e) => e.models.setDefault(modelId)),
    onProgress: (cb: (e: EmbeddingDownloadProgress) => void): (() => void) =>
      window.electron?.embeddings?.models?.onProgress?.(cb) ?? (() => {}),
  },
  getSettings: () => embeddings((e) => e.getSettings()),
  saveSettings: (config: { enabled?: boolean; modelId?: string }) =>
    embeddings((e) => e.saveSettings(config)),
};
