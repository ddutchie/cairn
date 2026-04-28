"use client";

/**
 * TitleBar — full-width draggable title bar for Electron.
 *
 * Sits at the very top of the window above the sidebar+content split.
 * Height matches the macOS traffic light zone (40px).
 * The left 80px is left clear for the traffic lights.
 * The entire bar is `-webkit-app-region: drag` so the window is
 * draggable from anywhere on it; interactive children opt out with
 * `-webkit-app-region: no-drag`.
 *
 * In the browser (non-Electron) this renders nothing.
 */

import { useEffect, useState } from "react";

export function TitleBar() {
  const [isElectron, setIsElectron] = useState(false);

  useEffect(() => {
    setIsElectron(typeof window !== "undefined" && !!window.electron);
  }, []);

  if (!isElectron) return null;

  return (
    <div
      className="flex items-center w-full flex-shrink-0 border-b border-[var(--border)] bg-[var(--surface)]"
      style={{
        height: 40,
        // Make the whole bar draggable
        WebkitAppRegion: "drag",
      } as React.CSSProperties}
    >
      {/* Traffic light clearance — 80px keeps clear of close/minimise/maximise */}
      <div style={{ width: 80, flexShrink: 0 }} />

      {/* App name centred in the remaining space — subtle, not competing with content */}
      <span
        className="text-xs text-[var(--text-tertiary)] font-medium tracking-wide select-none"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        Cairn
      </span>
    </div>
  );
}
