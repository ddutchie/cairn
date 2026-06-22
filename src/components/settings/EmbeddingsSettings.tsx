"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  CheckCircle, RefreshCw, Trash2, Star, Cpu, Activity, Download, Power,
} from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsRow, Toggle } from "./shared";
import { useCairnStore } from "@/store";

interface EmbeddingsConfig {
  enabled: boolean;
  modelId: string;
}

interface EmbeddingsStatus {
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

interface ModelEntry {
  id: string;
  name: string;
  repo: string;
  dim: number;
  maxTokens: number;
  sizeBytes: number;
  status: "not_downloaded" | "downloading" | "installed" | "error";
  downloadProgress: number;
  downloadSpeed?: string;
  error?: string;
}

interface ProgressEvent {
  modelId: string;
  status: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
  error?: string;
}

const DEFAULT_CONFIG: EmbeddingsConfig = { enabled: false, modelId: "Xenova/bge-small-en-v1.5" };

export function EmbeddingsSettings() {
  const [config, setConfig] = useState<EmbeddingsConfig>(DEFAULT_CONFIG);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [status, setStatus] = useState<EmbeddingsStatus>({
    running: false,
    port: null,
    activeModelId: null,
    defaultModelId: null,
    installed: false,
    error: null,
    reindexInProgress: false,
    recomputeInProgress: false,
    lastReindexDone: 0,
    lastReindexTotal: 0,
    lastRecomputeDone: 0,
    lastRecomputeTotal: 0,
  });
  const [progressByModel, setProgressByModel] = useState<Record<string, ProgressEvent>>({});
  const [reindexing, setReindexing] = useState(false);
  const [reindexResult, setReindexResult] = useState<string>("");
  const [reindexProgress, setReindexProgress] = useState<{ done: number; total: number } | null>(null);
  const [startingWorker, setStartingWorker] = useState(false);
  const activeWorkspaceId = useCairnStore((s) => s.activeWorkspaceId);

  const refreshQuiet = useCallback(async () => {
    if (!window.electron?.runtime) return;
    const [sRes, mrRes] = await Promise.allSettled([
      window.electron.runtime.embeddings.status(),
      window.electron.runtime.embeddings.models(),
    ]);
    if (sRes.status === "fulfilled") {
      const s = sRes.value;
      setStatus(s);
      const active = s.reindexInProgress || s.recomputeInProgress;
      setReindexing(active);
      if (s.reindexInProgress) {
        setReindexProgress({ done: s.lastReindexDone, total: s.lastReindexTotal });
      } else if (s.recomputeInProgress) {
        setReindexProgress({ done: s.lastRecomputeDone, total: s.lastRecomputeTotal });
      } else {
        setReindexProgress(null);
      }
      const defaultId = s.defaultModelId;
      if (defaultId && (!config.modelId || !models.some((x) => x.id === config.modelId))) {
        setConfig((c) => ({ ...c, modelId: defaultId }));
      }
    }
    if (mrRes.status === "fulfilled") {
      const m = mrRes.value.models as unknown as ModelEntry[];
      setModels(m);
      const defaultId = sRes.status === "fulfilled" ? sRes.value.defaultModelId : m[0]?.id;
      if (defaultId && (!config.modelId || !m.some((x) => x.id === config.modelId))) {
        setConfig((c) => ({ ...c, modelId: defaultId }));
      }
    }
    if (sRes.status === "rejected") console.warn("[embeddings] status() failed:", sRes.reason);
    if (mrRes.status === "rejected") console.warn("[embeddings] models() failed:", mrRes.reason);
  }, [config.modelId, models]);

  useEffect(() => {
    void (async () => {
      const e = window.electron;
      if (!e?.embeddings) return;
      const settings = await e.embeddings.getSettings();
      if (settings) {
        setConfig({
          enabled: settings.enabled ?? false,
          modelId: settings.modelId ?? DEFAULT_CONFIG.modelId,
        });
      }
      await refreshQuiet();
    })();

    const off = window.electron?.runtime?.embeddings.onProgress((ev) => {
      if (!ev.modelId) {
        if (ev.status === "progress" && typeof ev.loaded === "number" && typeof ev.total === "number") {
          setReindexProgress({ done: ev.loaded, total: ev.total });
        } else if (ev.status === "duplicate") {
          setReindexResult(`Blocked: ${ev.error ?? "already in progress"}`);
        } else if (ev.status === "installed" || ev.status === "ready") {
          setReindexProgress(null);
          void refreshQuiet();
        }
        return;
      }
      setProgressByModel((prev) => ({
        ...prev,
        [ev.modelId]: ev,
      }));
      if (ev.status === "installed" || ev.status === "ready") {
        void refreshQuiet();
      }
    });
    return () => {
      off?.();
    };
  }, [refreshQuiet]);

  const handleInstall = async (modelId: string) => {
    const rt = window.electron?.runtime;
    if (!rt) return;
    setProgressByModel((p) => ({ ...p, [modelId]: { modelId, status: "downloading", progress: 0 } }));
    try {
      await rt.embeddings.install(modelId);
    } catch (err) {
      console.error("[embeddings] install failed:", err);
      setProgressByModel((prev) => ({
        ...prev,
        [modelId]: { modelId, status: "error", error: err instanceof Error ? err.message : String(err) },
      }));
    } finally {
      await refreshQuiet();
    }
  };

  const handleRemove = async (modelId: string) => {
    const rt = window.electron?.runtime;
    if (!rt) return;
    try {
      await rt.embeddings.remove(modelId);
      await refreshQuiet();
    } catch (err) {
      console.error("[embeddings] remove failed:", err);
    }
  };

  const handleSetDefault = async (modelId: string) => {
    const e = window.electron;
    if (!e?.embeddings || !e.runtime) return;
    try {
      await e.runtime.embeddings.setDefault(modelId);
      const next = { ...config, modelId };
      setConfig(next);
      await e.embeddings.saveSettings(next);
      await refreshQuiet();
    } catch (err) {
      console.error("[embeddings] setDefault failed:", err);
    }
  };

  const handleToggleEnabled = async (enabled: boolean) => {
    const e = window.electron?.embeddings;
    const rt = window.electron?.runtime;
    if (!e || (enabled && !rt)) return;
    const next = { ...config, enabled };
    setConfig(next);
    await e.saveSettings(next);
    if (enabled) {
      setStartingWorker(true);
      try {
        // Ensure the unified runtime process is spawned and healthy
        await rt?.embeddings.ensureStarted();
        await refreshQuiet();
      } catch (err) {
        console.error("[embeddings] failed to start runtime:", err);
      } finally {
        setStartingWorker(false);
      }
    }
  };

  const handleStop = async () => {
    const rt = window.electron?.runtime;
    if (!rt) return;
    try {
      await rt.stop();
      await refreshQuiet();
    } catch (err) {
      console.error("[embeddings] stop failed:", err);
    }
  };

  const handleReindexAll = async () => {
    const e = window.electron?.embeddings;
    if (!e || !activeWorkspaceId) return;
    setReindexing(true);
    setReindexResult("");
    setReindexProgress(null);
    try {
      const res = await e.reindex(activeWorkspaceId, undefined, config.modelId);
      setReindexResult(`Indexed ${res.indexed}, skipped ${res.skipped} (total ${res.total})`);
    } catch (err) {
      setReindexResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReindexing(false);
      setReindexProgress(null);
    }
  };

  const handleRecomputeProjections = async () => {
    const e = window.electron?.embeddings;
    if (!e || !activeWorkspaceId) return;
    setReindexing(true);
    setReindexResult("");
    setReindexProgress(null);
    try {
      await e.recomputeProjections(activeWorkspaceId, config.modelId);
      setReindexResult("Projections updated.");
    } catch (err) {
      setReindexResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReindexing(false);
      setReindexProgress(null);
    }
  };

  const fmtSize = (bytes: number) => (bytes / 1024 / 1024).toFixed(0) + " MB";

  return (
    <SettingsGroup
      title="Embeddings (Local Semantic Search)"
      description="Run a local embedding model in a packaged worker binary so the Knowledge Graph and Notes sidebar can find semantically adjacent content offline."
    >
      <SettingsRow
        label="Enable embeddings"
        description="When on, notes get indexed automatically on save (debounced, incremental). Drives the Semantic Hubs panel in the Notes editor and the 'semantic' edges on the Knowledge Graph."
      >
        <Toggle checked={config.enabled} onChange={handleToggleEnabled} />
      </SettingsRow>

      {config.enabled && (
        <div className="space-y-3">
          <div className="px-4 py-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-[var(--text-secondary)]" />
                <div>
                  <div className="text-sm font-medium text-[var(--text-primary)]">Worker</div>
                  <div className="text-xs text-[var(--text-tertiary)]">
                    {status.running
                      ? `Running on 127.0.0.1:${status.port} · model: ${status.activeModelId ?? "—"}`
                      : status.installed
                        ? "Installed · idle (will start on first request)"
                        : "Not installed"}
                    {status.error ? ` · ${status.error}` : ""}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {status.running ? (
                  <Tooltip content="Stop worker">
                    <button
                      onClick={handleStop}
                      className="p-1.5 rounded hover:bg-[var(--surface-3)] text-[var(--text-tertiary)]"
                    >
                      <Power className="w-3.5 h-3.5" />
                    </button>
                  </Tooltip>
                ) : (
                  <Tooltip content="Refresh">
                    <button
                      onClick={refreshQuiet}
                      disabled={startingWorker}
                      className="p-1.5 rounded hover:bg-[var(--surface-3)] text-[var(--text-tertiary)] disabled:opacity-50"
                    >
                      <RefreshCw className={cn("w-3.5 h-3.5", startingWorker && "animate-spin")} />
                    </button>
                  </Tooltip>
                )}
              </div>
            </div>
          </div>

          <div className="px-4 py-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] space-y-3">
            <div className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wider">Models</div>
            {models.map((model) => {
              const prog = progressByModel[model.id];
              const isDownloading = model.status === "downloading" || (prog && (prog.status === "downloading" || prog.status === "progress") && (prog.progress ?? 0) < 100);
              const isInstalled = model.status === "installed";
              const isActive = status.running && status.activeModelId === model.id;
              const isDefault = status.defaultModelId === model.id;

              return (
                <div key={model.id} className="space-y-1.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-[var(--text-primary)]">{model.name}</div>
                      <div className="text-xs text-[var(--text-tertiary)] font-mono truncate">
                        {model.repo} · {model.dim}d · {fmtSize(model.sizeBytes)}
                        {isDefault && <span className="ml-1 text-[var(--accent)]">· default</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {isInstalled ? (
                        <>
                          {isActive ? (
                            <span className="text-xs text-[var(--success)] flex items-center gap-1">
                              <Activity className="w-3 h-3" /> running
                            </span>
                          ) : (
                            <CheckCircle className="w-4 h-4 text-[var(--success)]" />
                          )}
                          {!isDefault && (
                            <Tooltip content="Set as default">
                              <button
                                onClick={() => void handleSetDefault(model.id)}
                                className="p-1.5 rounded hover:bg-[var(--surface-3)] text-[var(--text-tertiary)]"
                              >
                                <Star className="w-3.5 h-3.5" />
                              </button>
                            </Tooltip>
                          )}
                          {!isActive && (
                            <Tooltip content="Delete from cache">
                              <button
                                onClick={() => void handleRemove(model.id)}
                                className="p-1.5 rounded hover:bg-[var(--surface-3)] text-[var(--text-tertiary)]"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </Tooltip>
                          )}
                        </>
                      ) : isDownloading ? (
                        <button
                          onClick={() => void handleRemove(model.id)}
                          className="text-xs px-2 py-1 rounded border border-[var(--border)] text-[var(--text-tertiary)] hover:bg-[var(--surface-3)]"
                        >
                          Cancel
                        </button>
                      ) : (
                        <button
                          onClick={() => void handleInstall(model.id)}
                          className="text-xs px-2 py-1 rounded bg-[var(--accent)] text-[var(--surface)] hover:opacity-90 flex items-center gap-1"
                        >
                          <Download className="w-3 h-3" />
                          Install (~{fmtSize(model.sizeBytes)})
                        </button>
                      )}
                    </div>
                  </div>

                  {isDownloading && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-[0.65rem] text-[var(--text-tertiary)]">
                        <span>{prog?.file ?? "downloading model files…"}</span>
                        <span className="font-mono">{Math.round(prog?.progress ?? 0)}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-[var(--surface-3)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[var(--accent)] rounded-full transition-all duration-300"
                          style={{ width: `${prog?.progress ?? 0}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {model.status === "error" && model.error && (
                    <div className="text-xs text-[var(--error)]">{model.error}</div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="px-4 py-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] space-y-2">
            <div className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wider">Maintenance</div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={handleReindexAll}
                disabled={reindexing || !activeWorkspaceId}
                className="text-xs px-2.5 py-1.5 rounded border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-3)] flex items-center gap-1.5 disabled:opacity-50"
              >
                <RefreshCw className={cn("w-3 h-3", reindexing && "animate-spin")} />
                Reindex notes (embed + search)
              </button>
              <button
                onClick={handleRecomputeProjections}
                disabled={reindexing || !activeWorkspaceId}
                className="text-xs px-2.5 py-1.5 rounded border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-3)] disabled:opacity-50"
              >
                Recompute graph clusters (UMAP only)
              </button>
            </div>
            <p className="text-[0.714rem] text-[var(--text-tertiary)]">
              Reindexing embeds every note and stores it for semantic search. Recompute clusters only runs UMAP on existing embeddings — cheap and fast, no model calls.
            </p>
            {reindexProgress && (
              <div className="space-y-1">
                <div className="flex justify-between text-[0.65rem] text-[var(--text-tertiary)]">
                  <span>Indexing notes…</span>
                  <span className="font-mono">
                    {reindexProgress.done}/{reindexProgress.total}
                    {reindexProgress.total > 0
                      ? ` · ${Math.round((reindexProgress.done / reindexProgress.total) * 100)}%`
                      : ""}
                  </span>
                </div>
                <div className="w-full h-1.5 bg-[var(--surface-3)] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[var(--accent)] rounded-full transition-all duration-300"
                    style={{
                      width: `${reindexProgress.total > 0
                        ? Math.round((reindexProgress.done / reindexProgress.total) * 100)
                        : 0}%`,
                    }}
                  />
                </div>
              </div>
            )}
            {reindexResult && (
              <div className="text-xs text-[var(--text-tertiary)]">{reindexResult}</div>
            )}
          </div>
        </div>
      )}
    </SettingsGroup>
  );
}
