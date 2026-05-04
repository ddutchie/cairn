"use client";

/**
 * ImageViewer — renders image files via base64 IPC data URL.
 * Uses agent:readFileBase64 to avoid file:// CSP restrictions in Electron.
 */

import { useEffect, useState } from "react";

interface ImageViewerProps {
  filePath: string;
}

export function ImageViewer({ filePath }: ImageViewerProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSrc(null);
    setError(null);
    if (!window.electron) return;
    (window.electron.agent.readFileBase64(filePath) as Promise<string>)
      .then((dataUrl) => setSrc(dataUrl))
      .catch((e: unknown) => setError(String(e)));
  }, [filePath]);

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--background)] overflow-auto p-4">
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={filePath.split("/").pop()}
          className="max-w-full max-h-full object-contain rounded"
        />
      )}
      {!src && !error && <p className="text-xs text-[var(--text-tertiary)]">Loading…</p>}
      <p className="text-[0.714rem] text-[var(--text-tertiary)] font-mono">{filePath.split("/").pop()}</p>
    </div>
  );
}
