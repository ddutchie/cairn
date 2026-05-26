"use client";

import React, { useState, useEffect } from "react";
import {
  CheckCircle, RefreshCw, Key, Globe, Cpu, Wifi, WifiOff, Eye, EyeOff, Trash2, Star
} from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsRow, Toggle } from "./shared";
import { MCPServerSettings } from "./MCPSettings";
import type { ToggleableView } from "@/store/slices/ui";

type TestState = "idle" | "testing" | "ok" | "error";

export function AISettings() {
  const { aiConfig, setAIConfig, hiddenViews, toggleViewVisibility } = useCairnStore(useShallow((s) => ({
    aiConfig:             s.aiConfig,
    setAIConfig:          s.setAIConfig,
    hiddenViews:          s.hiddenViews,
    toggleViewVisibility: s.toggleViewVisibility,
  })));

  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<TestState>("idle");
  const [testError, setTestError] = useState("");

  // Llama local model manager state
  const [llamaModels, setLlamaModels] = useState<any[]>([]);
  const [serverStatus, setServerStatus] = useState<{
    running: boolean;
    port: number | null;
    activeModelId: string | null;
    defaultModelId: string | null;
    installed: boolean;
    error: string | null;
  }>({
    running: false,
    port: null,
    activeModelId: null,
    defaultModelId: null,
    installed: true,
    error: null
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
    if (!window.electron || !window.electron.llama) return;
    setUpdateCheck({ loading: true, result: null, error: null });
    try {
      const res = await window.electron.llama.binary.checkForUpdates();
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

  async function refreshLlamaState() {
    if (typeof window === "undefined" || !window.electron || !window.electron.llama) return;
    setIsRefreshing(true);
    try {
      const list = await window.electron.llama.models.list();
      setLlamaModels(list);
      const status = await window.electron.llama.server.status();
      setServerStatus(status);
    } catch (e) {
      console.error("Failed to fetch llama state:", e);
    } finally {
      setIsRefreshing(false);
    }
  }

  async function refreshLlamaStateQuiet() {
    if (typeof window === "undefined" || !window.electron || !window.electron.llama) return;
    try {
      const list = await window.electron.llama.models.list();
      setLlamaModels(list);
      const status = await window.electron.llama.server.status();
      setServerStatus(status);
    } catch (e) {
      console.error("Failed to fetch llama state:", e);
    }
  }

  useEffect(() => {
    if (typeof window !== "undefined" && window.electron && window.electron.llama) {
      refreshLlamaState();
      handleCheckForUpdates();

      // Listen to download progress
      const unsub = window.electron.llama.models.onProgress((event) => {
        setDownloadProgresses((prev) => ({
          ...prev,
          [event.modelId]: {
            progress: event.progress,
            speed: event.speed,
            status: event.status,
            error: event.error
          }
        }));
        // Periodically refresh list to update manifest statuses
        refreshLlamaStateQuiet();
      });

      // Listen to binary installer progress
      const unsubBinary = window.electron.llama.binary.onProgress((event) => {
        setBinaryProgress(event);
        if (event.status === "installed") {
          refreshLlamaStateQuiet();
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
    if (!window.electron || !window.electron.llama) return;
    try {
      setServerStatus((prev) => ({ ...prev, error: null }));
      await window.electron.llama.server.start(modelId);
      await refreshLlamaState();
    } catch (e) {
      console.error("Failed to start llama server:", e);
      setServerStatus((prev) => ({ ...prev, error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleSetDefaultModel(modelId: string) {
    if (!window.electron || !window.electron.llama) return;
    try {
      await window.electron.llama.server.setDefault(modelId);
      await refreshLlamaState();
    } catch (e) {
      console.error("Failed to set default model:", e);
    }
  }

  async function handleStopServer() {
    if (!window.electron || !window.electron.llama) return;
    try {
      await window.electron.llama.server.stop();
      await refreshLlamaState();
    } catch (e) {
      console.error("Failed to stop llama server:", e);
    }
  }

  async function handleInstallModel(modelId: string) {
    if (!window.electron || !window.electron.llama) return;
    try {
      // Optimistic progress
      setDownloadProgresses((prev) => ({
        ...prev,
        [modelId]: { progress: 0, status: "downloading" }
      }));
      await window.electron.llama.models.install(modelId, useMirror);
      await refreshLlamaState();
    } catch (e) {
      console.error("Failed to trigger install:", e);
    }
  }

  async function handleRemoveModel(modelId: string) {
    if (!window.electron || !window.electron.llama) return;
    try {
      await window.electron.llama.models.remove(modelId);
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
    if (!window.electron || !window.electron.llama) return;
    try {
      await window.electron.llama.models.clearInactive();
      await refreshLlamaState();
    } catch (e) {
      console.error("Failed to clear inactive models:", e);
    }
  }

  async function handleInstallBinary() {
    if (!window.electron || !window.electron.llama) return;
    try {
      setBinaryProgress({ progress: 0, status: "fetching_release" });
      await window.electron.llama.binary.install();
      await refreshLlamaState();
      await handleCheckForUpdates(); // Refresh version info to show "Up to date"
    } catch (e) {
      console.error("Failed to install local binary:", e);
    }
  }

  // Available models fetched from the general endpoint
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  // General config destructuring
  const { provider = "openai", baseUrl, model, apiKey, aiEnabled } = aiConfig;
  const isLocal =
    baseUrl.includes("localhost") ||
    baseUrl.includes("127.0.0.1") ||
    baseUrl.includes("0.0.0.0");

  function updateAIConfig(patch: Partial<typeof aiConfig>) {
    setAIConfig(patch);
    if (patch.baseUrl !== undefined) {
      setAvailableModels([]);
    }
  }

  async function fetchModels() {
    setModelsLoading(true);
    try {
      const url = (baseUrl || "https://api.openai.com").replace(/\/+$/, "").replace(/\/v1$/, "");
      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      const res = await fetch(`${url}/v1/models`, { headers });
      if (!res.ok) throw new Error(`${res.status}`);

      const data = await res.json();
      const ids: string[] = (data?.data ?? [])
        .map((m: { id: string }) => m.id)
        .filter((id: string) => {
          return !id.includes("embed") && !id.includes("whisper") && !id.includes("tts") && !id.includes("dall-e");
        })
        .sort();

      setAvailableModels(ids);
      setTestState("ok");
    } catch (err) {
      setTestState("error");
      setTestError(err instanceof Error ? err.message : "Failed to fetch models");
      setAvailableModels([]);
    } finally {
      setModelsLoading(false);
      setTimeout(() => setTestState("idle"), 5000);
    }
  }

  const fallbackModels = isLocal
    ? ["llama3.2", "llama3.1", "qwen2.5:14b", "mistral", "phi4", "gemma3:12b"]
    : ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "gpt-4", "o1-mini", "o3-mini"];

  const modelOptions = availableModels.length > 0 ? availableModels : fallbackModels;

  return (
    <div className="space-y-8">
      {/* ── Visibility ── */}
      <SettingsGroup
        title="Visibility"
        description="Control which AI features and views are shown."
      >
        <SettingsRow
          label="Enable inline AI"
          description="Shows AI buttons in the editor — text actions, PRD generator, task spawning, and Idea Flow AI summaries. Does not affect the Agent or Chat views."
        >
          <Toggle
            checked={aiEnabled ?? true}
            onChange={(v) => updateAIConfig({ aiEnabled: v })}
          />
        </SettingsRow>
        {([
          { view: "agent" as ToggleableView, label: "Agent view", description: "Embedded coding agent in the sidebar" },
          { view: "chat"  as ToggleableView, label: "AI Chat view", description: "In-app AI chat panel" },
        ]).map(({ view, label, description }) => {
          const visible = !hiddenViews.has(view);
          return (
            <SettingsRow key={view} label={label} description={description}>
              <Toggle checked={visible} onChange={() => toggleViewVisibility(view)} />
            </SettingsRow>
          );
        })}
      </SettingsGroup>

      {/* ── General Chat & Inline AI Feature Config ── */}
      <SettingsGroup
        title="General Chat & Inline AI"
        description="Configure endpoints for the main AI Chat panel, in-editor inline text actions, PRD writer, and summaries. Supports offline private models."
      >
        {/* Provider Switcher */}
        <SettingsRow
          label="AI Provider"
          description="Choose between local on-device Apple Intelligence or standard cloud/local API connections."
        >
          <div className="flex gap-2">
            <button
              onClick={() => updateAIConfig({ provider: "openai" })}
              className={cn(
                "px-3 py-1.5 text-xs rounded-md border transition-all flex items-center gap-2 cursor-pointer",
                provider === "openai"
                  ? "border-[var(--accent)] text-[var(--text-primary)] bg-[var(--accent-dim)] font-medium"
                  : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]"
              )}
            >
              <Globe size={12} />
              Cloud / Local API
            </button>
            <button
              onClick={() => updateAIConfig({ provider: "localllm" })}
              className={cn(
                "px-3 py-1.5 text-xs rounded-md border transition-all flex items-center gap-2 relative cursor-pointer",
                provider === "localllm"
                  ? "border-[var(--accent)] text-[var(--text-primary)] bg-[var(--accent-dim)] font-medium"
                  : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]"
              )}
            >
              <Cpu size={12} className={provider === "localllm" ? "text-[var(--accent)] animate-pulse" : ""} />
              Local Gemma 4
            </button>
          </div>
        </SettingsRow>

        {provider === "localllm" ? (
          <div className="space-y-3 pt-3 border-t border-[var(--border-subtle)]">
            <div>
              <h4 className="text-sm font-semibold text-[var(--text-primary)]">Local Gemma 4 Server Console</h4>
              <p className="text-xs text-[var(--text-tertiary)] mt-0.5 leading-relaxed">
                Manage your offline Gemma 4 models and the local llama-server instance.
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
                        className="px-2.5 py-1 text-xs border border-red-500/30 text-red-500 hover:bg-red-500/10 rounded transition-colors cursor-pointer"
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
                          className="px-2.5 py-1 text-xs bg-[var(--accent)] text-white hover:bg-[var(--accent-dim)] hover:text-[var(--accent)] rounded transition-all font-medium cursor-pointer"
                        >
                          Start Server
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Llama Engine Version / Update status */}
              {serverStatus.installed && (
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
                          className="px-2.5 py-1 bg-[var(--accent)] text-white hover:bg-[var(--accent-dim)] hover:text-[var(--accent)] rounded font-semibold transition-all text-[0.65rem] cursor-pointer shadow-sm"
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

              {serverStatus.installed && binaryProgress && (
                <div className="bg-[var(--surface-3)] p-3 rounded-lg border border-[var(--border)] mb-4 space-y-2">
                  <div className="flex justify-between text-[0.714rem]">
                    <span className="text-[var(--text-primary)] font-medium capitalize flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 bg-yellow-500 rounded-full animate-ping" />
                      Upgrading: {binaryProgress.status.replace("_", " ")}...
                    </span>
                    <span className="text-[var(--text-tertiary)] font-mono">
                      {binaryProgress.progress}% {binaryProgress.speed ? `(${binaryProgress.speed})` : ""}
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-[var(--surface-1)] rounded-full overflow-hidden border border-[var(--border)]">
                    <div
                      className="h-full bg-gradient-to-r from-[var(--accent)] to-indigo-500 rounded-full transition-all duration-300"
                      style={{ width: `${binaryProgress.progress}%` }}
                    />
                  </div>
                  {binaryProgress.error && (
                    <p className="text-[0.65rem] text-red-400 font-mono">Error: {binaryProgress.error}</p>
                  )}
                </div>
              )}

              {/* Automated 1-Click Engine Downloader Card */}
              {!serverStatus.installed && (
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
                          className="h-full bg-gradient-to-r from-[var(--accent)] to-indigo-500 rounded-full transition-all duration-300"
                          style={{ width: `${binaryProgress.progress}%` }}
                        />
                      </div>
                      {binaryProgress.error && (
                        <p className="text-[0.65rem] text-red-400 font-mono">Error: {binaryProgress.error}</p>
                      )}
                    </div>
                  ) : (
                    <div className="flex gap-3 flex-wrap">
                      <button
                        onClick={handleInstallBinary}
                        className="px-3.5 py-1.5 text-xs bg-[var(--accent)] text-white hover:bg-[var(--accent-dim)] hover:text-[var(--accent)] rounded font-semibold transition-all shadow-sm flex items-center gap-1.5 cursor-pointer"
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
                      Or run the Homebrew command above, then restart Cairn to activate the private Gemma 4 integration.
                    </p>
                  </div>
                </div>
              )}

              {/* Server Error Log if any */}
              {serverStatus.error && (
                <div className="bg-red-500/5 border border-red-500/20 text-red-400 p-3.5 rounded-lg text-[0.786rem] font-mono whitespace-pre-wrap max-h-36 overflow-y-auto">
                  {serverStatus.error}
                </div>
              )}

              {/* Model Quantization Manager */}
              <div className="space-y-3">
                <div className="flex justify-between items-center flex-wrap gap-2">
                  <h5 className="text-[0.714rem] font-bold uppercase tracking-wider text-[var(--text-tertiary)]">
                    Local Gemma 4 Models
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
                      onClick={refreshLlamaState}
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
                    const dl = downloadProgresses[model.id] || { progress: model.downloadProgress, status: model.status, speed: model.downloadSpeed };
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
                                {model.repo} · {model.quant}
                              </span>
                            </div>
                            <p className="text-[0.714rem] text-[var(--text-secondary)]">
                              File: <code className="bg-[var(--surface-1)] px-1 py-0.5 rounded font-mono text-[0.65rem]">{model.filename}</code>
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
                                    ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                                    : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-amber-500/20 hover:text-amber-400"
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
                                  "p-1.5 rounded border border-red-500/20 text-red-400 hover:bg-red-500/10 transition-colors",
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
                                <span className="text-[0.65rem] bg-[var(--accent)] text-white px-2 py-1 rounded font-medium shadow-sm">
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
                                className="px-2 py-1 text-xs border border-[var(--border)] text-[var(--text-tertiary)] hover:border-red-500/20 hover:text-red-400 rounded transition-colors cursor-pointer"
                              >
                                Cancel
                              </button>
                            ) : (
                              <button
                                onClick={() => handleInstallModel(model.id)}
                                className="px-2.5 py-1 text-xs bg-[var(--accent)] text-white hover:bg-[var(--accent-dim)] hover:text-[var(--accent)] rounded font-medium transition-all cursor-pointer"
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
                                <span className="w-1.5 h-1.5 bg-yellow-500 rounded-full animate-ping" />
                                Downloading...
                              </span>
                              <span className="text-[var(--text-tertiary)] font-mono">
                                {dl.progress}% {dl.speed ? `(${dl.speed})` : ""}
                              </span>
                            </div>
                            <div className="w-full h-1.5 bg-[var(--surface-1)] rounded-full overflow-hidden border border-[var(--border)]">
                              <div
                                className="h-full bg-gradient-to-r from-[var(--accent)] to-indigo-500 rounded-full transition-all duration-300"
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
                    className="text-red-400 hover:underline flex items-center gap-1 cursor-pointer"
                  >
                    Clear Inactive Models
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Base URL */}
            <SettingsRow
              label="Base URL"
              description="Root URL. The chat route appends /v1/chat/completions."
            >
              <div className="flex flex-col gap-1.5 items-end">
                <div className="relative">
                  <Globe size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                  <input
                    type="url"
                    value={baseUrl}
                    onChange={(e) => updateAIConfig({ baseUrl: e.target.value })}
                    placeholder="https://api.openai.com"
                    className="pl-7 pr-3 py-1.5 text-xs w-64 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-dim)]"
                  />
                </div>
                <div className="flex gap-1.5">
                  {[
                    { label: "OpenAI", url: "https://api.openai.com" },
                    { label: "Ollama", url: "http://localhost:11434" },
                    { label: "LM Studio", url: "http://localhost:1234" },
                  ].map(({ label, url }) => (
                    <button
                      key={label}
                      onClick={() => updateAIConfig({ baseUrl: url })}
                      className={cn(
                        "px-2 py-1 text-[0.714rem] rounded border transition-colors cursor-pointer",
                        baseUrl === url
                          ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                          : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]"
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </SettingsRow>

            {/* API Key */}
            <SettingsRow
              label="API Key"
              description={
                isLocal
                  ? "Local servers don't need a key — leave blank."
                  : "Required for OpenAI. Leave blank to use the OPENAI_API_KEY server env var."
              }
            >
              <div className="relative">
                <Key size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => updateAIConfig({ apiKey: e.target.value })}
                  placeholder={isLocal ? "optional" : "sk-…"}
                  className="pl-7 pr-8 py-1.5 text-xs w-52 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-dim)]"
                />
                <Tooltip content={showKey ? "Hide API key" : "Show API key"} side="top">
                  <button
                    onClick={() => setShowKey((s) => !s)}
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                  >
                    {showKey ? <EyeOff size={11} /> : <Eye size={11} />}
                  </button>
                </Tooltip>
              </div>
            </SettingsRow>

            {/* Model Selection */}
            <SettingsRow
              label="Model"
              description={
                availableModels.length > 0
                  ? `${availableModels.length} models loaded from endpoint`
                  : "Type a model name or fetch the list from your endpoint."
              }
            >
              <div className="flex flex-col gap-1.5 items-end w-64">
                <div className="flex gap-1.5 w-full">
                  <div className="relative flex-1">
                    <Cpu size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                    <input
                      type="text"
                      value={model}
                      onChange={(e) => updateAIConfig({ model: e.target.value })}
                      placeholder="gpt-4o-mini"
                      className="pl-7 pr-3 py-1.5 text-xs w-full rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-dim)]"
                    />
                  </div>
                  <button
                    onClick={fetchModels}
                    disabled={modelsLoading}
                    aria-label="Fetch general models from endpoint"
                    className={cn(
                      "px-2 py-1.5 text-[0.714rem] rounded-md border transition-colors flex items-center gap-1 min-w-[52px] justify-center",
                      "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]",
                      modelsLoading && "opacity-50 cursor-wait"
                    )}
                  >
                    <RefreshCw size={11} className={modelsLoading ? "animate-spin" : ""} />
                    {modelsLoading ? "…" : "Fetch"}
                  </button>
                </div>

                {testState === "error" && (
                  <p className="text-[0.786rem] text-[var(--danger)] self-start" title={testError}>
                    {testError.slice(0, 60)}
                  </p>
                )}
                {testState === "ok" && availableModels.length > 0 && (
                  <p className="text-[0.786rem] text-[var(--success)] self-start flex items-center gap-1">
                    <CheckCircle size={10} /> {availableModels.length} models available
                  </p>
                )}

                <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto w-full pr-0.5">
                  {modelOptions.map((m) => (
                    <button
                      key={m}
                      onClick={() => updateAIConfig({ model: m })}
                      className={cn(
                        "px-2 py-0.5 text-[0.714rem] rounded border transition-colors font-mono whitespace-nowrap",
                        model === m
                          ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                          : "border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)] hover:text-[var(--text-secondary)]"
                      )}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            </SettingsRow>
          </>
        )}

        {/* General Connection Status */}
        <div className="flex items-center gap-3 pt-1 text-xs">
          {provider === "localllm" ? (
            <>
              <span className={cn(
                "flex items-center gap-1",
                serverStatus.running ? "text-[var(--success)]" : "text-[var(--text-tertiary)]"
              )}>
                <CheckCircle size={11} /> {serverStatus.running ? "Connected (Local Gemma 4)" : "Offline (Local Gemma 4)"}
              </span>
              <span className="text-[var(--text-tertiary)]">·</span>
              <span className="text-[var(--text-tertiary)] font-mono">
                {serverStatus.running && serverStatus.activeModelId
                  ? llamaModels.find(m => m.id === serverStatus.activeModelId)?.name || "Local Gemma 4"
                  : "No active local model"
                }
              </span>
            </>
          ) : (
            <>
              <span className={cn(
                "flex items-center gap-1",
                testState === "ok" ? "text-[var(--success)]" : testState === "error" ? "text-[var(--danger)]" : "text-[var(--text-tertiary)]"
              )}>
                {testState === "ok" && <><CheckCircle size={11} /> Connected</>}
                {testState === "error" && <><WifiOff size={11} /> Error</>}
                {(testState === "idle" || testState === "testing") && <><Wifi size={11} /> {testState === "testing" ? "Connecting…" : "Not tested"}</>}
              </span>
              <span className="text-[var(--text-tertiary)]">·</span>
              <span className="text-[var(--text-tertiary)] font-mono truncate max-w-40">{baseUrl.replace(/^https?:\/\//, "")}</span>
              <span className="text-[var(--text-tertiary)]">·</span>
              <span className="text-[var(--text-tertiary)] font-mono">{model || "no model"}</span>
            </>
          )}
        </div>
      </SettingsGroup>

      {/* ── MCP Server ── */}
      <MCPServerSettings />
    </div>
  );
}
