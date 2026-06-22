/**
 * Adapter interface — the contract every inference runtime implements.
 *
 * Each adapter (llama, onnx, future MLX) implements this interface.
 * The unified runtime server registers adapters and routes requests to them.
 * Adding a new runtime = implement this interface + register with the server.
 *
 * Lifecycle:
 *   1. `start()` — spawn child process / load model into memory
 *   2. `health()` — polled by the server's /health endpoint
 *   3. `handleRequest()` — called for each HTTP request to /v1/<kind>/...
 *   4. `stop()` — graceful shutdown
 */

export type AdapterKind = "llm" | "embedding";

export interface AdapterStatus {
  kind: AdapterKind;
  running: boolean;
  model: string | null;
  port: number | null;
  error: string | null;
}

export interface AdapterHealth {
  healthy: boolean;
  model: string | null;
  loaded: boolean;
  error?: string | null;
}

export interface AdapterConfig {
  /** Directory where model files are stored */
  modelsDir: string;
  /** Directory where engine binaries are stored */
  binDir: string;
  /** Default model id to use when none is specified */
  defaultModelId: string | null;
  /** Optional callback for progress events (downloads, model loading) */
  onProgress?: (event: AdapterProgressEvent) => void;
}

export type AdapterProgressEvent =
  | {
      type: "download";
      modelId: string;
      progress: number;
      speed?: string;
      status: "downloading" | "installed" | "error";
      error?: string;
    }
  | {
      type: "load";
      modelId: string;
      status: string;
      file?: string;
      progress?: number;
      loaded?: number;
      total?: number;
    }
  | {
      type: "ready";
      modelId: string;
    };

/**
 * An adapter manages one inference runtime.
 *
 * The adapter is responsible for:
 * - Starting/stopping the runtime process or loading/unloading the model
 * - Health checking
 * - Routing HTTP-style requests to the runtime's API
 * - Model installation and removal
 *
 * The adapter does NOT manage ports, HTTP servers, or IPC — that's the
 * runtime server's job. The adapter just exposes the operations.
 */
export interface RuntimeAdapter {
  /** Unique identifier for this adapter (e.g. "llama", "onnx", "mlx") */
  readonly id: string;
  /** What kind of inference this adapter provides */
  readonly kind: AdapterKind;

  /**
   * Start the runtime with the given model.
   * If already running with the same model, return immediately.
   * If running with a different model, stop and restart.
   */
  start(modelId: string, opts?: { contextLimit?: number }): Promise<{ port: number }>;

  /** Stop the runtime. Safe to call when not running. */
  stop(opts?: { force?: boolean }): Promise<void>;

  /** Check if the runtime is healthy and responding. */
  health(): Promise<AdapterHealth>;

  /** Current status snapshot (synchronous, does not poll). */
  status(): AdapterStatus;

  /** Stop and cleanup — called on app shutdown. */
  dispose(): Promise<void>;
}

/**
 * Extended interface for adapters that manage model downloads
 * (both llama and onnx adapters implement this).
 */
export interface ModelManagingAdapter extends RuntimeAdapter {
  /** List all known models with their current status. */
  listModels(): AdapterModelEntry[];

  /** Download and install a model. */
  installModel(modelId: string): Promise<void>;

  /** Remove a model from disk. */
  removeModel(modelId: string): void;

  /** Get the default model id, if one is set. */
  getDefaultModelId(): string | null;

  /** Set the default model id. */
  setDefaultModelId(modelId: string): void;

  /** Check if model files are present on disk. */
  isModelInstalled(modelId: string): boolean;
}

export interface AdapterModelEntry {
  id: string;
  name: string;
  repo: string;
  sizeBytes: number;
  status: "not_downloaded" | "downloading" | "installed" | "error";
  downloadProgress: number;
  downloadSpeed?: string;
  error?: string;
  /** Adapter-specific metadata (e.g. quant, filename, dim, maxTokens) */
  meta?: Record<string, unknown>;
}
