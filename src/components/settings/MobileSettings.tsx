"use client";

import React, { useEffect, useState } from "react";
import { Smartphone, RefreshCw, Key, Link, Shield, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow, Toggle } from "./shared";
import { cn } from "@/lib/utils";

interface MobileStatus {
  running: boolean;
  url: string;
  qrCode: string;
  pin: string;
}

export function MobileSettings() {
  const [status, setStatus] = useState<MobileStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [pinMode, setPinMode] = useState(true); // default authEnabled true

  const fetchStatus = async () => {
    if (typeof window !== "undefined" && window.electron && window.electron.mobile) {
      try {
        const res = await window.electron.mobile.status();
        if (res) {
          setStatus(res as MobileStatus);
        }
      } catch (err) {
        console.error("Failed to fetch mobile access status:", err);
      }
    }
  };

  useEffect(() => {
    fetchStatus();
    // Refresh status periodically
    const timer = setInterval(fetchStatus, 5000);
    return () => clearInterval(timer);
  }, []);

  const handleToggleAccess = async (enabled: boolean) => {
    if (typeof window === "undefined" || !window.electron || !window.electron.mobile) return;
    setLoading(true);
    try {
      const res = await window.electron.mobile.saveSettings({ enabled });
      setStatus(res as MobileStatus);
    } catch (err) {
      console.error("Failed to save mobile settings:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleAuth = async (authEnabled: boolean) => {
    if (typeof window === "undefined" || !window.electron || !window.electron.mobile) return;
    setLoading(true);
    try {
      const res = await window.electron.mobile.saveSettings({ authEnabled });
      setStatus(res as MobileStatus);
    } catch (err) {
      console.error("Failed to save auth settings:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleRegeneratePin = async () => {
    if (typeof window === "undefined" || !window.electron || !window.electron.mobile) return;
    setLoading(true);
    try {
      const res = await window.electron.mobile.regeneratePin();
      setStatus(res as MobileStatus);
    } catch (err) {
      console.error("Failed to regenerate PIN:", err);
    } finally {
      setLoading(false);
    }
  };

  if (!status) {
    return (
      <div className="flex items-center justify-center py-8">
        <span className="text-xs text-[var(--text-tertiary)] animate-pulse">Loading settings…</span>
      </div>
    );
  }

  return (
    <SettingsGroup title="Mobile Access" description="Connect to Cairn on your mobile phone or tablet over your local Wi-Fi network.">
      <SettingsRow label="Local network access" description="Expose Cairn to other devices on the same Wi-Fi network.">
        <Toggle
          checked={status.running}
          onChange={handleToggleAccess}
        />
      </SettingsRow>

      {status.running && (
        <div className="mt-4 p-4 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] space-y-4 animate-fade-in">
          {/* Connection Details */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--accent)]">
                <Link size={13} />
                Connection URL
              </div>
              <div className="text-sm font-mono text-[var(--text-primary)] select-all selection:bg-[var(--accent)] selection:text-white">
                {status.url}
              </div>
              <p className="text-[10px] text-[var(--text-tertiary)] max-w-sm">
                Make sure your mobile device is connected to the same Wi-Fi network as this computer.
              </p>
            </div>

            {/* QR Code Container */}
            {status.qrCode && (
              <div className="flex flex-col items-center justify-center p-2 rounded-lg bg-white border border-[var(--border)] shadow-sm self-center md:self-end">
                <img
                  src={status.qrCode}
                  alt="Connection QR Code"
                  className="w-32 h-32 object-contain"
                  style={{ imageRendering: "pixelated" }}
                />
                <span className="text-[10px] text-gray-500 font-medium mt-1">Scan to connect</span>
              </div>
            )}
          </div>

          <hr className="border-[var(--border)] opacity-30" />

          {/* Authentication Section */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
                  <Shield size={13} className="text-emerald-500" />
                  PIN Code Authentication
                </div>
                <p className="text-[10px] text-[var(--text-tertiary)] mt-0.5 max-w-xs">
                  Enforces validation using a unique PIN code upon first visiting from a new browser.
                </p>
              </div>
              <Toggle
                checked={status.pin !== ""} // auth is enabled if pin is set
                onChange={async (checked) => {
                  await handleToggleAuth(checked);
                }}
              />
            </div>

            {status.pin && (
              <div className="flex items-center justify-between p-3 rounded-lg border border-[var(--border)] bg-[var(--surface-3)]">
                <div className="flex items-center gap-2">
                  <Key size={13} className="text-[var(--text-secondary)]" />
                  <span className="text-xs font-medium text-[var(--text-secondary)]">Current PIN Code:</span>
                  <span className="text-sm font-bold tracking-widest font-mono text-[var(--text-primary)] px-2 py-0.5 rounded bg-[var(--surface-2)]">
                    {status.pin}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="w-7 h-7 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                  onClick={handleRegeneratePin}
                  disabled={loading}
                >
                  <RefreshCw size={12} className={cn("transition-transform", loading && "animate-spin")} />
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {!status.running && (
        <div className="flex gap-2.5 p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] opacity-80 mt-4">
          <AlertCircle size={14} className="text-[var(--text-tertiary)] mt-0.5 shrink-0" />
          <p className="text-[10px] text-[var(--text-tertiary)] leading-normal">
            Exposing your workspace over the local network allows you to access notes, kanban boards, and chat with AI agents on other devices. Activate network access above to see connection links.
          </p>
        </div>
      )}
    </SettingsGroup>
  );
}
