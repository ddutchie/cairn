"use client";

/**
 * TitleBar — full-width draggable title bar for Electron.
 *
 * macOS (hiddenInset):
 *   - 80px left clearance for traffic lights (close/minimise/maximise)
 *   - App name centred in remaining space
 *   - Right side free
 *
 * Windows (hidden + titleBarOverlay):
 *   - Native min/max/close buttons rendered by the OS overlay at the right
 *   - ~138px right clearance so clicks reach the native buttons
 *   - App name left-aligned with left padding
 *   - No left clearance needed
 *
 * In the browser (non-Electron) this renders nothing.
 */

import { useState } from "react";

export function TitleBar() {
  const [platform] = useState<"darwin" | "win32" | "linux" | null>(
    () => (typeof window !== "undefined" && window.electron)
      ? (window.electron.platform ?? "linux")
      : null
  );

  if (!platform) return null;

  const isWin = platform === "win32";
  const isMac = platform === "darwin";

  return (
    <div
      className="flex items-center w-full flex-shrink-0 border-b border-[var(--border)] bg-[var(--surface)]"
      style={{
        height: 40,
        WebkitAppRegion: "drag",
      } as React.CSSProperties}
    >
      {/* macOS: clear 80px for traffic lights on the left */}
      {isMac && <div style={{ width: 80, flexShrink: 0 }} />}

      {/* App name */}
      <span
        className="text-xs text-[var(--text-tertiary)] font-medium tracking-wide select-none"
        style={{
          WebkitAppRegion: "drag",
          paddingLeft: isWin ? 12 : 0,
        } as React.CSSProperties}
      >
        Cairn
      </span>

      {/* Windows: spacer pushes nothing, but we need the right zone clear for the overlay buttons */}
      <div style={{ flex: 1 }} />

      {/* Windows: 138px right clearance for native min/max/close overlay (Electron default button width) */}
      {isWin && <div style={{ width: 138, flexShrink: 0 }} />}
    </div>
  );
}
