"use client";

import { useState, useEffect, useCallback } from "react";
import { Download, CheckCircle, Sparkles, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Shell, NavRow } from "./shared";

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

interface Props {
  enabled: boolean;
  modelId: string;
  onEnabledChange: (v: boolean) => void;
  onModelIdChange: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
}

const DEFAULT_MODEL_ID = "Xenova/bge-small-en-v1.5";

export function StepEmbeddings({
  enabled,
  modelId,
  onEnabledChange,
  onModelIdChange,
  onBack,
  onNext,
}: Props) {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    const rt = window.electron?.runtime;
    if (!rt) return;
    const [mrRes, stRes] = await Promise.allSettled([
      rt.embeddings.models(),
      rt.embeddings.status(),
    ]);
    if (mrRes.status === "fulfilled") {
      const m = mrRes.value.models as unknown as ModelEntry[];
      setModels(m);
      const defaultId = (stRes.status === "fulfilled" ? stRes.value.defaultModelId : undefined) ?? m[0]?.id ?? DEFAULT_MODEL_ID;
      if (!modelId || !m.some((x) => x.id === modelId)) {
        onModelIdChange(defaultId);
      }
    }
    if (mrRes.status === "rejected") console.warn("[embeddings] models() failed:", mrRes.reason);
    if (stRes.status === "rejected") console.warn("[embeddings] status() failed:", stRes.reason);
    setReady(true);
  }, [modelId, onModelIdChange]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const off = window.electron?.runtime?.embeddings.onProgress((ev) => {
      setProgress(ev);
      if (ev.status === "installed" || ev.status === "ready") {
        void refresh();
      }
    });
    return () => { off?.(); };
  }, [refresh]);

  async function handleInstall(id: string) {
    const rt = window.electron?.runtime;
    if (!rt) return;
    setProgress({ modelId: id, status: "downloading", progress: 0 });
    try {
      await rt.embeddings.install(id);
      await refresh();
    } catch (err) {
      setProgress({ modelId: id, status: "error", error: String(err) });
    }
  }

  const model = models.find((m) => m.id === (modelId || DEFAULT_MODEL_ID));
  const isDownloading =
    model?.status === "downloading" ||
    (progress?.modelId === model?.id &&
      (progress?.status === "downloading" || progress?.status === "progress") &&
      (progress?.progress ?? 0) < 100);
  const isInstalled = model?.status === "installed";
  const pct = Math.round(progress?.progress ?? model?.downloadProgress ?? 0);
  const fmtSize = (b: number) => (b / 1024 / 1024).toFixed(0) + " MB";

  return (
    <Shell step="embeddings">
      <div className="w-full max-w-md flex flex-col gap-4">
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5 flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <Sparkles className="w-4 h-4 text-[var(--accent)] mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-[var(--text-secondary)] mb-0.5">
                Semantic Embeddings
              </p>
              <p className="text-[0.714rem] text-[var(--text-tertiary)] leading-relaxed">
                Cairn can run a small local model to embed your notes for semantic
                search and Knowledge Graph edges. Runs entirely offline — your notes
                never leave the machine.
              </p>
            </div>
          </div>

          {/* Toggle */}
          <button
            type="button"
            onClick={() => onEnabledChange(!enabled)}
            className={cn(
              "flex items-center justify-between px-3 py-2 rounded-lg border transition-colors",
              enabled
                ? "bg-[var(--accent-dim)]"
                : "border-[var(--border)] bg-[var(--surface-2)]"
            )}
            style={enabled ? { borderColor: "color-mix(in srgb, var(--accent) 40%, transparent)" } : undefined}
          >
            <span className="text-xs font-medium text-[var(--text-primary)]">
              {enabled ? "Enabled" : "Disabled"}
            </span>
            <div
              className={cn(
                "w-9 h-5 rounded-full transition-colors relative",
                enabled ? "bg-[var(--accent)]" : "bg-[var(--surface-3)]"
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 w-4 h-4 rounded-full bg-[var(--accent-fg,#fff)] shadow-sm transition-all",
                  enabled ? "left-[18px]" : "left-0.5"
                )}
              />
            </div>
          </button>

          {/* Model card */}
          {enabled && (
            <div className="mt-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 space-y-2">
              {model ? (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[var(--text-primary)]">
                        {model.name}
                      </div>
                      <div className="text-[0.65rem] text-[var(--text-tertiary)] font-mono truncate">
                        {model.repo} · {model.dim}d · {fmtSize(model.sizeBytes)}
                      </div>
                    </div>
                    {isInstalled ? (
                      <span className="flex items-center gap-1 text-xs text-[var(--success)]">
                        <CheckCircle className="w-4 h-4" /> Ready
                      </span>
                    ) : isDownloading ? (
                      <Loader2 className="w-4 h-4 text-[var(--accent)] animate-spin" />
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleInstall(model.id)}
                        className="text-xs px-2 py-1 rounded bg-[var(--accent)] text-[var(--surface)] hover:opacity-90 flex items-center gap-1"
                      >
                        <Download className="w-3 h-3" />
                        Download (~{fmtSize(model.sizeBytes)})
                      </button>
                    )}
                  </div>

                  {isDownloading && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-[0.65rem] text-[var(--text-tertiary)]">
                        <span>{progress?.file ?? "downloading model files…"}</span>
                        <span className="font-mono">{pct}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-[var(--surface-3)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[var(--accent)] rounded-full transition-all duration-300"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {model.status === "error" && model.error && (
                    <div className="text-xs text-[var(--error)]">{model.error}</div>
                  )}
                </>
              ) : (
                <div className="text-xs text-[var(--text-tertiary)]">
                  Loading model catalog…
                </div>
              )}
            </div>
          )}

          <p className="text-[0.65rem] text-[var(--text-tertiary)] leading-relaxed">
            You can enable this later in Settings. Background reindexing runs after
            download completes; large libraries may take a few minutes.
          </p>
        </div>

        <NavRow
          onBack={onBack}
          onNext={onNext}
          nextLabel="Continue"
          nextDisabled={!ready}
        />
      </div>
    </Shell>
  );
}
