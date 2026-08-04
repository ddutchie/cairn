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

import { useState, useEffect } from "react";
import { Bell, Loader2 } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { SyncStatusIndicator } from "./sync-status-indicator";

export function TitleBar() {
  // Start as null on both server and client so SSR output matches the initial
  // client render (no hydration mismatch). The real platform is set after
  // mount — imperceptible in Electron since it renders before the first frame.
  const [platform, setPlatform] = useState<"darwin" | "win32" | "linux" | null>(null);

  const { notificationUnreadCount, setNotificationOpen, runningAutomationCount, setView } = useCairnStore(useShallow((s) => ({
    notificationUnreadCount: s.notificationUnreadCount,
    setNotificationOpen: s.setNotificationOpen,
    runningAutomationCount: s.runningAutomationCount,
    setView: s.setView,
  })));

  useEffect(() => {
    const isElectron = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
    if (window.electron && isElectron) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPlatform(window.electron.platform ?? "linux");
    }
  }, []);

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

      {/* Right zone: running-automations icon + notification bell + live sync status (no-drag so they're clickable) */}
      <div className="flex items-center gap-1 pr-2" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        {runningAutomationCount > 0 && (
          <button
            onClick={() => setView("automations")}
            className="flex items-center justify-center w-7 h-7 rounded-md text-[var(--accent)] hover:bg-[var(--surface-2)] transition-colors"
            title={`${runningAutomationCount} automation${runningAutomationCount === 1 ? "" : "s"} running`}
            aria-label="Automations running"
          >
            <Loader2 size={14} className="animate-spin" />
          </button>
        )}
        <button
          onClick={() => setNotificationOpen(true)}
          className={cn(
            "relative flex items-center justify-center w-7 h-7 rounded-md transition-colors",
            notificationUnreadCount > 0
              ? "text-[var(--accent)] hover:bg-[var(--surface-2)]"
              : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
          )}
          title="Notifications"
          aria-label="Notifications"
        >
          <Bell
            size={14}
            className={cn(
              notificationUnreadCount > 0 && "animate-bell-wobble fill-[var(--accent)]"
            )}
          />
        </button>
        <SyncStatusIndicator />
      </div>

      {/* Windows: 138px right clearance for native min/max/close overlay (Electron default button width) */}
      {isWin && <div style={{ width: 138, flexShrink: 0 }} />}
    </div>
  );
}
