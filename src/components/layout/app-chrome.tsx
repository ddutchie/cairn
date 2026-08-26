"use client";

import React from "react";
import { Download, X, AlertCircle } from "lucide-react";
import type { ErrorToast } from "@/hooks/useIpcErrorToasts";

/**
 * Auto-updater banner — shown when an update is available or downloaded.
 */
export function UpdateBanner({
  version,
  downloaded,
  onInstall,
  onDismiss,
}: {
  version: string | null;
  downloaded: boolean;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  if (!version && !downloaded) return null;
  return (
    <div className="flex items-center gap-3 px-4 h-9 bg-[var(--accent-dim)] border-b border-[color-mix(in_srgb,var(--accent)_30%,transparent)] flex-shrink-0">
      <Download size={13} className="text-[var(--accent)] shrink-0" />
      <span className="text-xs text-[var(--text-secondary)] flex-1">
        {downloaded
          ? <>Cairn <strong className="text-[var(--text-primary)]">v{version}</strong> is ready to install.</>
          : <>Downloading Cairn <strong className="text-[var(--text-primary)]">v{version}</strong>…</>}
      </span>
      {downloaded && (
        <button
          onClick={onInstall}
          className="px-3 py-1 rounded-md text-xs font-medium bg-[var(--accent)] text-[var(--background)] hover:bg-[var(--accent-hover)] transition-colors"
        >
          Restart &amp; install
        </button>
      )}
      <button onClick={onDismiss} className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors">
        <X size={12} />
      </button>
    </div>
  );
}

/**
 * IPC error toasts — bottom-right, auto-dismiss after 5s.
 */
export function ErrorToasts({
  toasts,
  onDismiss,
}: {
  toasts: ErrorToast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
      aria-live="assertive"
      aria-relevant="additions"
      aria-atomic="false"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="alert"
          className="flex items-start gap-2 px-3 py-2.5 rounded-lg border border-[color-mix(in_srgb,var(--danger)_30%,transparent)] bg-[var(--background)] shadow-lg max-w-xs pointer-events-auto"
        >
          <AlertCircle size={13} className="text-[var(--danger)] shrink-0 mt-0.5" />
          <span className="text-xs text-[var(--text-secondary)] flex-1 leading-relaxed">{toast.message}</span>
          <button
            onClick={() => onDismiss(toast.id)}
            className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors shrink-0"
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}
