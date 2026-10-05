/**
 * Local embeddings (semantic search, note map) and the unified runtime that
 * serves them. Shared by the main-process embeddings service/runtime client,
 * the typed IPC contract and the renderer.
 */

export interface EmbeddingsStatus {
  running: boolean;
  port: number | null;
  activeModelId: string | null;
  defaultModelId: string | null;
  installed: boolean;
  error: string | null;
  reindexInProgress: boolean;
  recomputeInProgress: boolean;
  lastReindexDone: number;
  lastReindexTotal: number;
  lastRecomputeDone: number;
  lastRecomputeTotal: number;
}

export type EmbeddingModelStatus = "not_downloaded" | "downloading" | "installed" | "error";

/** A model in the embeddings catalog with its local install state. */
export interface EmbeddingModelManifestEntry {
  id: string;
  name: string;
  repo: string;
  dim: number;
  maxTokens: number;
  sizeBytes: number;
  status: EmbeddingModelStatus;
  downloadProgress: number;
  downloadSpeed?: string;
  error?: string;
}

/** A model as the unified runtime's adapter reports it. */
export interface RuntimeEmbeddingModel {
  id: string;
  name: string;
  repo: string;
  sizeBytes: number;
  status: EmbeddingModelStatus;
  downloadProgress: number;
  downloadSpeed?: string;
  error?: string;
  /** Adapter-specific metadata (e.g. quant, filename, dim, maxTokens). */
  meta?: Record<string, unknown>;
}

/** Model download progress, pushed on `embeddings:download-progress` / `runtime:download-progress`. */
export interface EmbeddingDownloadProgress {
  modelId: string;
  status: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
  error?: string;
}

export interface ReindexResult {
  indexed: number;
  skipped: number;
  total: number;
}

export interface ProjectionResult {
  projected: number;
  total: number;
}

/** A semantically adjacent note section. */
export interface AdjacentNote {
  noteId: string;
  title: string;
  score: number;
  sectionTitle: string;
}

/** A note's 2-D position on the semantic map. */
export interface NoteProjectionRow {
  noteId: string;
  dimX: number;
  dimY: number;
  projStale: number;
  embeddedAt: string;
  model: string;
}

export interface RuntimeStatus {
  embeddings: { healthy: boolean; model: string | null; loaded: boolean };
}
