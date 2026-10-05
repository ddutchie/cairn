/**
 * App-level payloads (workspace setup, migrations, AI helpers, updater) shared
 * by the renderer, the Electron main process and the typed IPC contract
 * (`shared/ipc/contract.ts`).
 */

/** Read-only preview of a folder before onboarding adopts it. */
export interface VaultImportPreview {
  isObsidianVault: boolean;
  vaultName: string;
  noteCount: number;
  skippedCount: number;
  projects: Array<{ name: string; noteCount: number; root: boolean; projectKey: string }>;
  excludedFolders: string[];
}

/** `app:rescanWorkspace`: projects the scan created from folders, with their imported note counts. */
export interface WorkspaceRescanResult {
  projectsCreated: number;
  createdProjects: Array<{ id: string; name: string; noteCount: number }>;
}

/** A workspace migration and whether this workspace still needs it. */
export interface MigrationStatus {
  id: string;
  title: string;
  description: string;
  needed: boolean;
}

/** Progress pushed on `app:migrationProgress` while a migration runs. */
export interface MigrationProgress {
  migrationId: string;
  pct: number;
  msg: string;
}

/** Orphaned files from the retired on-device LLM engine (Settings → Data). */
export interface LlmLeftovers {
  bytes: number;
  files: Array<{ name: string; bytes: number }>;
}

/** models.dev per-1M-token USD pricing for one model. */
export interface ModelPrice {
  input: number | null;
  output: number | null;
  /** USD per 1M prompt-cache-read tokens (models.dev cost.cache_read). */
  cacheRead?: number | null;
  /** USD per 1M prompt-cache-write tokens (models.dev cost.cache_write). */
  cacheWrite?: number | null;
}

/** Connection the renderer sends with an AI helper call; `apiKey` is a keychain ref (or empty). */
export interface AiRequestConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** Endpoint to probe for models or credits; `apiKey` is a keychain ref (or empty). */
export interface AiEndpoint {
  baseUrl?: string;
  apiKey?: string;
}

/** `ai:generatePrd`: the note the PRD was saved to. */
export interface PrdResult {
  id: string;
  title: string;
  projectId: string;
  content: string;
}

/** Pushed on `updater:update-available`. */
export interface UpdateAvailableInfo {
  version: string;
  releaseNotes: string | null;
}
