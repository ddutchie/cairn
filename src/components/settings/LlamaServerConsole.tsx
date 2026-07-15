"use client";

import React, { useState, useEffect } from "react";
import { CheckCircle, RefreshCw, Cpu, Trash2, Star } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * On-Device Llama server console — the entire `provider === "localllm"` surface
 * of AISettings, extracted so the parent stays a thin provider switch. Owns all
 * llama-runtime state (model list, server status, download/binary progress,
 * update check) and its lifecycle effect + action handlers. Also renders the
 * local-provider connection-status footer (its `serverStatus`/`llamaModels`
 * live here, so the status line lives here too).
 *
 * `contextLimit` / `onContextLimitChange` cross the boundary because they're
 * persisted in the shared aiConfig (the context-window selector + server start).
 * `maxStepsRow` is the shared Max-steps control, rendered in its original
 * position (after the console body, before the connection-status line) so the
 * layout order is identical to before the extraction.
 */
/**
 * A downloadable/installed local Llama model, as returned (untyped) by
 * `runtime.llm.models()`. Only the fields this console reads are declared.
 */
interface LlamaModel {
  id: string;
  name: string;
  repo: string;
  status: string;
  downloadProgress?: number;
  downloadSpeed?: string;
  sizeBytes: number;
  meta?: { quant?: string; filename?: string };
}

export function LlamaServerConsole({
  contextLimit,
  onContextLimitChange,
  maxStepsRow,
}: {
  contextLimit: number | undefined;
  onContextLimitChange: (n: number) => void;
  maxStepsRow: React.ReactNode;
}) {
  const [llamaModels, setLlamaModels] = useState<LlamaModel[]>([]);
  const [serverStatus, setServerStatus] = useState<{
    running: boolean;
    port: number | null;
    activeModelId: string | null;
    defaultModelId: string | null;
    binaryInstalled: boolean;
  }>({
    running: false,
    port: null,
    activeModelId: null,
    defaultModelId: null,
    binaryInstalled: true,
  });

  const [downloadProgresses, setDownloadProgresses] = useState<Record<string, { progress: number; speed?: string; status: string; error?: string }>>({});
  const [binaryProgress, setBinaryProgress] = useState<{ progress: number; speed?: string; status: string; error?: string } | null>(null);
  const [useMirror, setUseMirror] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<{
    loading: boolean;
    result: { updateAvailable: boolean; currentVersion: string | null; latestVersion: string | null } | null;
    error: string | null;
  } | null>(null);

  async function handleCheckForUpdates() {
    if (!window.electron || !window.electron.runtime) return;
    setUpdateCheck({ loading: true, result: null, error: null });
    try {
      const res = await window.electron.runtime.llm.binary.checkForUpdates();
      setUpdateCheck({ loading: false, result: res, error: null });
    } catch (e) {
      console.error("Failed to check for updates:", e);
      setUpdateCheck({
        loading: false,
        result: null,
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  async function refreshLlamaState(quiet = false) {
    if (typeof window === "undefined" || !window.electron || !window.electron.runtime) return;
    if (!quiet) setIsRefreshing(true);
    try {
      const { models: list } = await window.electron.runtime.llm.models();
      setLlamaModels(list as unknown as LlamaModel[]);
      const status = await window.electron.runtime.llm.server.status();
      setServerStatus(status);
    } catch (e) {
      console.error("Failed to fetch llama state:", e);
    } finally {
      if (!quiet) setIsRefreshing(false);
    }
  }

  useEffect(() => {
    if (typeof window !== "undefined" && window.electron && window.electron.runtime) {
      // Defer initial state fetch to avoid setState-in-effect cascade
      Promise.resolve().then(() => {
        refreshLlamaState();
        handleCheckForUpdates();
      });

      // Listen to download progress
      const unsub = window.electron.runtime.llm.onProgress((event) => {
        setDownloadProgresses((prev) => ({
          ...prev,
          [event.modelId]: {
            progress: event.progress ?? 0,
            speed: event.speed,
            status: event.status,
            error: event.error
          }
        }));
        // Periodically refresh list to update manifest statuses
        refreshLlamaState(true);
      });

      // Listen to binary installer progress
      const unsubBinary = window.electron.runtime.llm.binary.onProgress((event) => {
        setBinaryProgress(event);
        if (event.status === "installed") {
          refreshLlamaState(true);
          setTimeout(() => setBinaryProgress(null), 3000);
        }
      });

      return () => {
        unsub();
        unsubBinary();
      };
    }
  }, []);

  async function handleStartServer(modelId: string) {
    if (!window.electron || !window.electron.runtime) return;
    try {
      await window.electron.runtime.llm.server.start(modelId, contextLimit);
      await refreshLlamaState();
    } catch (e) {
      console.error("Failed to start llama server:", e);
    }
  }

  async function handleSetDefaultModel(modelId: string) {
    if (!window.electron || !window.electron.runtime) return;
    try {
      await window.electron.runtime.llm.server.setDefault(modelId);
      await refreshLlamaState();
    } catch (e) {
      console.error("Failed to set default model:", e);
    }
  }

  async function handleStopServer() {
    if (!window.electron || !window.electron.runtime) return;
    try {
      await window.electron.runtime.llm.server.stop();
      await refreshLlamaState();
    } catch (e) {
      console.error("Failed to stop llama server:", e);
    }
  }

  async function handleInstallModel(modelId: string) {
    if (!window.electron || !window.electron.runtime) return;
    try {
      // Optimistic progress
      setDownloadProgresses((prev) => ({
        ...prev,
        [modelId]: { progress: 0, status: "downloading" }
      }));
      await window.electron.runtime.llm.install(modelId, useMirror);
      await refreshLlamaState();
    } catch (e) {
      console.error("Failed to trigger install:", e);
      // Clear the optimistic "downloading" entry so the UI drops the stuck
      // progress bar / cancel control instead of hanging on a failed install.
      setDownloadProgresses((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
    }
  }

  async function handleRemoveModel(modelId: string) {
    if (!window.electron || !window.electron.runtime) return;
    try {
      await window.electron.runtime.llm.remove(modelId);
      setDownloadProgresses((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
      await refreshLlamaState();
    } catch (e) {
      console.error("Failed to delete model:", e);
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleClearInactive() {
    if (!window.electron || !window.electron.runtime) return;
    try {
      await window.electron.runtime.llm.clearInactive();
      await refreshLlamaState();
    } catch (e) {
      console.error("Failed to clear inactive models:", e);
    }
  }

  async function handleInstallBinary() {
    if (!window.electron || !window.electron.runtime) return;
    try {
      setBinaryProgress({ progress: 0, status: "fetching_release" });
      await window.electron.runtime.llm.binary.install();
      await refreshLlamaState();
      await handleCheckForUpdates(); // Refresh version info to show "Up to date"
    } catch (e) {
      console.error("Failed to install local binary:", e);
    }
  }

  return (
    <>
      <div className="space-y-3 pt-3 border-t border-[var(--border-subtle)]">
        <div>
          <h4 className="text-sm font-semibold text-[var(--text-primary)]">On-Device Server Console</h4>
          <p className="text-xs text-[var(--text-tertiary)] mt-0.5 leading-relaxed">
            Manage your offline Llama models and the local llama-server instance.
          </p>
        </div>

        <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-5 space-y-5 w-full text-left">
          {/* Server Status Header */}
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-[var(--accent-dim)] flex items-center justify-center text-[var(--accent)] font-bold shadow-sm">
                <Cpu size={16} className={serverStatus.running ? "animate-pulse" : ""} />
              </div>
              <div>
                <h4 className="text-xs font-semibold text-[var(--text-primary)]">Llama Server Process</h4>
                <p className="text-[0.714rem] text-[var(--text-tertiary)] flex items-center gap-1.5">
                  {serverStatus.running ? `Running locally on Port ${serverStatus.port}` : "Offline / Idle"}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              {serverStatus.running ? (
                <>
                  <span className="text-[0.714rem] flex items-center gap-1.5 text-[var(--success)] font-medium bg-[color-mix(in_srgb,var(--success)_10%,transparent)] px-2.5 py-1 rounded-md">
                    <span className="w-2 h-2 rounded-full bg-[var(--success)] animate-ping" />
                    Active &amp; Ready
                  </span>
                  <button
                    onClick={handleStopServer}
                    className="px-2.5 py-1 text-xs border border-[color-mix(in_srgb,var(--danger)_30%,transparent)] text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] rounded transition-colors cursor-pointer"
                  >
                    Stop Server
                  </button>
                </>
              ) : (
                <>
                  <span className="text-[0.714rem] flex items-center gap-1.5 text-[var(--text-tertiary)] font-medium bg-[var(--surface-3)] px-2.5 py-1 rounded-md border border-[var(--border)]">
                    Offline
                  </span>
                  {llamaModels.some(m => m.status === "installed") && (
                    <button
                      onClick={() => {
                        const firstInstalled = llamaModels.find(m => m.status === "installed");
                        if (firstInstalled) handleStartServer(firstInstalled.id);
                      }}
                      className="px-2.5 py-1 text-xs bg-[var(--accent)] text-[var(--background)] hover:bg-[var(--accent-dim)] hover:text-[var(--accent)] rounded transition-all font-medium cursor-pointer"
                    >
                      Start Server
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Llama Engine Version / Update status */}
          {serverStatus.binaryInstalled && (
            <div className="flex items-center justify-between text-[0.714rem] text-[var(--text-secondary)] border-b border-[var(--border-subtle)] pb-4 pt-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-[var(--text-primary)]">Llama Engine:</span>
                {updateCheck?.result ? (
                  <span className="font-mono bg-[var(--surface-3)] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-primary)]">
                    {updateCheck.result.currentVersion || "Local / Manual"}
                  </span>
                ) : (
                  <span className="text-[var(--text-tertiary)] italic">Loading engine metadata...</span>
                )}
              </div>

              <div>
                {updateCheck?.loading ? (
                  <span className="flex items-center gap-1.5 text-[var(--accent)] font-medium">
                    <RefreshCw size={10} className="animate-spin" />
                    Checking for updates...
                  </span>
                ) : updateCheck?.result?.updateAvailable ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[var(--warning)] font-semibold bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-2 py-0.5 rounded">
                      Update Available: {updateCheck.result.latestVersion}
                    </span>
                    <button
                      onClick={handleInstallBinary}
                      className="px-2.5 py-1 bg-[var(--accent)] text-[var(--background)] hover:bg-[var(--accent-dim)] hover:text-[var(--accent)] rounded font-semibold transition-all text-[0.65rem] cursor-pointer shadow-sm"
                    >
                      Upgrade Engine
                    </button>
                  </div>
                ) : updateCheck?.result ? (
                  <span className="text-[var(--success)] font-semibold flex items-center gap-1 bg-[color-mix(in_srgb,var(--success)_10%,transparent)] px-2.5 py-1 rounded-md">
                    <CheckCircle size={10} /> Up to date
                  </span>
                ) : (
                  <button
                    onClick={handleCheckForUpdates}
                    className="text-[var(--accent)] hover:underline flex items-center gap-1 cursor-pointer font-semibold"
                  >
                    <RefreshCw size={10} /> Check for Updates
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Local Context Limit Row */}
          {serverStatus.binaryInstalled && (
            <div className="flex items-center justify-between text-[0.714rem] text-[var(--text-secondary)] border-b border-[var(--border-subtle)] pb-4 pt-1">
              <div className="flex flex-col gap-0.5">
                <span className="font-semibold text-[var(--text-primary)]">Local Context Limit:</span>
                <span className="text-[0.65rem] text-[var(--text-tertiary)] mt-0.5">Context window per query. Clamps for memory stability.</span>
              </div>
              <div>
                <select
                  value={contextLimit || 16384}
                  onChange={(e) => onContextLimitChange(parseInt(e.target.value, 10))}
                  className="px-2.5 py-1 text-[0.714rem] rounded-md bg-[var(--surface-3)] border border-[var(--border)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] cursor-pointer"
                >
                  <option value={4096}>4,096 tokens (Fast / Low RAM)</option>
                  <option value={8192}>8,192 tokens (Standard)</option>
                  <option value={16384}>16,384 tokens (Recommended)</option>
                  <option value={32768}>32,768 tokens (Heavy VRAM)</option>
                  {contextLimit && ![4096, 8192, 16384, 32768].includes(contextLimit) && (
                    <option value={contextLimit}>Custom: {contextLimit.toLocaleString()} tokens</option>
                  )}
                </select>
              </div>
            </div>
          )}

          {serverStatus.binaryInstalled && binaryProgress && (
            <div className="bg-[var(--surface-3)] p-3 rounded-lg border border-[var(--border)] mb-4 space-y-2">
              <div className="flex justify-between text-[0.714rem]">
                <span className="text-[var(--text-primary)] font-medium capitalize flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 bg-[var(--warning)] rounded-full animate-ping" />
                  Upgrading: {binaryProgress.status.replace("_", " ")}...
                </span>
                <span className="text-[var(--text-tertiary)] font-mono">
                  {binaryProgress.progress}% {binaryProgress.speed ? `(${binaryProgress.speed})` : ""}
                </span>
              </div>
              <div className="w-full h-1.5 bg-[var(--surface-1)] rounded-full overflow-hidden border border-[var(--border)]">
                <div
                  className="h-full bg-gradient-to-r from-[var(--accent)] to-[var(--accent)] rounded-full transition-all duration-300"
                  style={{ width: `${binaryProgress.progress}%` }}
                />
              </div>
              {binaryProgress.error && (
                <p className="text-[0.65rem] text-[var(--danger)] font-mono">Error: {binaryProgress.error}</p>
              )}
            </div>
          )}

          {/* Automated 1-Click Engine Downloader Card */}
          {!serverStatus.binaryInstalled && (
            <div className="bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] rounded-lg p-5 space-y-4">
              <div className="flex items-center gap-2 text-[var(--accent)] font-semibold text-xs">
                <Cpu size={14} className={binaryProgress?.status === "downloading" || binaryProgress?.status === "extracting" ? "animate-spin" : ""} />
                Automated Llama Engine Setup
              </div>
              <p className="text-[0.786rem] text-[var(--text-secondary)] leading-relaxed">
                Cairn runs private offline inference using the native C++ compiled <strong>llama-server</strong> engine. 
                We can automatically download the latest tiny compiled binary (~15MB) from GitHub, set it up locally, and configure macOS permissions for you.
              </p>

              {binaryProgress ? (
                <div className="space-y-2 bg-[var(--surface-3)] p-3 rounded-lg border border-[var(--border)]">
                  <div className="flex justify-between text-[0.714rem]">
                    <span className="text-[var(--text-primary)] font-medium capitalize">
                      {binaryProgress.status.replace("_", " ")}...
                    </span>
                    <span className="text-[var(--text-tertiary)] font-mono">
                      {binaryProgress.progress}% {binaryProgress.speed ? `(${binaryProgress.speed})` : ""}
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-[var(--surface-1)] rounded-full overflow-hidden border border-[var(--border)]">
                    <div
                      className="h-full bg-gradient-to-r from-[var(--accent)] to-[var(--accent)] rounded-full transition-all duration-300"
                      style={{ width: `${binaryProgress.progress}%` }}
                    />
                  </div>
                  {binaryProgress.error && (
                    <p className="text-[0.65rem] text-[var(--danger)] font-mono">Error: {binaryProgress.error}</p>
                  )}
                </div>
              ) : (
                <div className="flex gap-3 flex-wrap">
                  <button
                    onClick={handleInstallBinary}
                    className="px-3.5 py-1.5 text-xs bg-[var(--accent)] text-[var(--background)] hover:bg-[var(--accent-dim)] hover:text-[var(--accent)] rounded font-semibold transition-all shadow-sm flex items-center gap-1.5 cursor-pointer"
                  >
                    <RefreshCw size={11} />
                    1-Click Install Local Engine
                  </button>
                </div>
              )}

              <div className="border-t border-[var(--border)] pt-3 space-y-2">
                <p className="text-[0.65rem] text-[var(--text-tertiary)] uppercase tracking-wider font-semibold">
                  Alternative manual installation
                </p>
                <div className="bg-[var(--surface-1)] border border-[var(--border)] p-2.5 rounded font-mono text-[0.714rem] text-[var(--text-primary)] flex items-center justify-between">
                  <span>brew install llama.cpp</span>
                  <button
                    onClick={() => navigator.clipboard.writeText("brew install llama.cpp")}
                    className="text-[var(--accent)] hover:underline text-[0.65rem]"
                  >
                    Copy
                  </button>
                </div>
                <p className="text-[0.714rem] text-[var(--text-tertiary)]">
                  Or run the Homebrew command above, then restart Cairn to activate the private on-device model integration.
                </p>
              </div>
            </div>
          )}

          {/* Server Error Log if any */}
          {/* Note: runtime status doesn't surface error string; errors are shown via download progress */}

          {/* Model Quantization Manager */}
          <div className="space-y-3">
            <div className="flex justify-between items-center flex-wrap gap-2">
              <h5 className="text-[0.714rem] font-bold uppercase tracking-wider text-[var(--text-tertiary)]">
                On-Device Llama Models
              </h5>
              
              <div className="flex items-center gap-4">
                {/* Mirror Toggle */}
                <label className="flex items-center gap-2 text-[0.714rem] text-[var(--text-secondary)] font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useMirror}
                    onChange={(e) => setUseMirror(e.target.checked)}
                    className="accent-[var(--accent)] rounded"
                  />
                  <span>🚀 High-Speed Mirror (hf-mirror.com)</span>
                </label>

                <button
                  onClick={() => refreshLlamaState()}
                  disabled={isRefreshing}
                  className="text-[0.714rem] text-[var(--accent)] hover:underline flex items-center gap-1 cursor-pointer"
                >
                  <RefreshCw size={10} className={isRefreshing ? "animate-spin" : ""} />
                  Refresh
                </button>
              </div>
            </div>

            <div className="space-y-3">
              {llamaModels.map((model) => {
                const dl = downloadProgresses[model.id] || { progress: model.downloadProgress ?? 0, status: model.status, speed: model.downloadSpeed };
                const isDownloading = dl.status === "downloading";
                const isInstalled = dl.status === "installed" || model.status === "installed";
                const isActive = serverStatus.running && serverStatus.activeModelId === model.id;
                const isDefault = serverStatus.defaultModelId === model.id;

                return (
                  <div
                    key={model.id}
                    className={cn(
                      "border border-[var(--border)] rounded-lg p-3.5 transition-all bg-[var(--surface-3)]",
                      isActive && "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_4%,var(--surface-3))]"
                    )}
                  >
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-semibold text-[var(--text-primary)]">{model.name}</span>
                          <span className="text-[0.65rem] text-[var(--text-tertiary)] font-mono">
                            {model.repo} · {model.meta?.quant}
                          </span>
                        </div>
                        <p className="text-[0.714rem] text-[var(--text-secondary)]">
                            File: <code className="bg-[var(--surface-1)] px-1 py-0.5 rounded font-mono text-[0.65rem]">{model.meta?.filename}</code>
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        {/* Star / Set Default button */}
                        {isInstalled && (
                          <button
                            onClick={() => handleSetDefaultModel(model.id)}
                            className={cn(
                              "p-1.5 rounded border transition-colors cursor-pointer",
                              isDefault
                                ? "border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[var(--warning)]"
                                : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[color-mix(in_srgb,var(--warning)_20%,transparent)] hover:text-[var(--warning)]"
                            )}
                            title={isDefault ? "Current default startup model" : "Set as default startup model"}
                          >
                            <Star size={12} fill={isDefault ? "currentColor" : "none"} />
                          </button>
                        )}

                        {/* Delete/Uninstall button */}
                        {isInstalled && (
                          <button
                            disabled={isActive}
                            onClick={() => handleRemoveModel(model.id)}
                            className={cn(
                              "p-1.5 rounded border border-[color-mix(in_srgb,var(--danger)_20%,transparent)] text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] transition-colors",
                              isActive ? "opacity-30 cursor-not-allowed" : "cursor-pointer"
                            )}
                            title={isActive ? "Cannot delete model currently loaded in the active server." : "Delete downloaded weights"}
                          >
                            <Trash2 size={12} />
                          </button>
                        )}

                        {/* Main Action buttons */}
                        {isInstalled ? (
                          isActive ? (
                            <span className="text-[0.65rem] bg-[var(--accent)] text-[var(--background)] px-2 py-1 rounded font-medium shadow-sm">
                              Running &amp; Locked
                            </span>
                          ) : (
                            <button
                              onClick={() => handleStartServer(model.id)}
                              className="px-2.5 py-1 text-xs border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent-dim)] rounded font-medium transition-all cursor-pointer"
                            >
                              Load Model
                            </button>
                          )
                        ) : isDownloading ? (
                          <button
                            onClick={() => handleRemoveModel(model.id)}
                            className="px-2 py-1 text-xs border border-[var(--border)] text-[var(--text-tertiary)] hover:border-[color-mix(in_srgb,var(--danger)_20%,transparent)] hover:text-[var(--danger)] rounded transition-colors cursor-pointer"
                          >
                            Cancel
                          </button>
                        ) : (
                          <button
                            onClick={() => handleInstallModel(model.id)}
                            className="px-2.5 py-1 text-xs bg-[var(--accent)] text-[var(--background)] hover:bg-[var(--accent-dim)] hover:text-[var(--accent)] rounded font-medium transition-all cursor-pointer"
                          >
                            Download (~{(model.sizeBytes / 1024 / 1024 / 1024).toFixed(1)} GB)
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Progress Bar for Downloading models */}
                    {isDownloading && (
                      <div className="mt-3.5 space-y-1.5">
                        <div className="flex justify-between text-[0.65rem]">
                          <span className="text-[var(--text-secondary)] font-medium flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 bg-[var(--warning)] rounded-full animate-ping" />
                            Downloading...
                          </span>
                          <span className="text-[var(--text-tertiary)] font-mono">
                            {dl.progress}% {dl.speed ? `(${dl.speed})` : ""}
                          </span>
                        </div>
                        <div className="w-full h-1.5 bg-[var(--surface-1)] rounded-full overflow-hidden border border-[var(--border)]">
                          <div
                            className="h-full bg-gradient-to-r from-[var(--accent)] to-[var(--accent)] rounded-full transition-all duration-300"
                            style={{ width: `${dl.progress}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Footer utilities */}
          <div className="flex items-center justify-between border-t border-[var(--border)] pt-4 text-[0.714rem] text-[var(--text-tertiary)]">
            <span>Storage path: <code className="font-mono bg-[var(--surface-3)] px-1.5 py-0.5 rounded">userData/llama-models/</code></span>
            {llamaModels.some(m => m.status === "installed" && m.id !== serverStatus.activeModelId) && (
              <button
                onClick={handleClearInactive}
                className="text-[var(--danger)] hover:underline flex items-center gap-1 cursor-pointer"
              >
                Clear Inactive Models
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Max steps — shared control, kept in its original position. */}
      {maxStepsRow}

      {/* Local-provider connection status (its serverStatus/llamaModels live here) */}
      <div className="flex items-center gap-3 pt-1 text-xs">
        <span className={cn(
          "flex items-center gap-1",
          serverStatus.running ? "text-[var(--success)]" : "text-[var(--text-tertiary)]"
        )}>
          <CheckCircle size={11} /> {serverStatus.running ? "Connected (On-Device Llama)" : "Offline (On-Device Llama)"}
        </span>
        <span className="text-[var(--text-tertiary)]">·</span>
        <span className="text-[var(--text-tertiary)] font-mono">
          {serverStatus.running && serverStatus.activeModelId
            ? llamaModels.find(m => m.id === serverStatus.activeModelId)?.name || "On-Device"
            : "No active local model"
          }
        </span>
      </div>
    </>
  );
}
