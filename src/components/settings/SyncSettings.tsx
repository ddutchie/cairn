"use client";

import React, { useEffect, useState } from "react";
import { FolderSync, RefreshCw, FolderOpen, AlertCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow } from "./shared";
import { cn } from "@/lib/utils";

interface SyncNowResult {
  drained: number;
  seeded: number;
  peerOpsApplied: number;
  conflictCopies: number;
  connected: boolean;
}

// window.electron.sync is added in preload.ts; type it locally to avoid a
// global d.ts edit.
type SyncApi = {
  getFolder: () => Promise<string | null>;
  selectFolder: () => Promise<string | null>;
  clearFolder: () => Promise<{ ok: true }>;
  now: () => Promise<SyncNowResult>;
};

function syncApi(): SyncApi | null {
  if (typeof window === "undefined" || !window.electron) return null;
  return (window.electron as unknown as { sync?: SyncApi }).sync ?? null;
}

export function SyncSettings() {
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<SyncNowResult | null>(null);

  useEffect(() => {
    const api = syncApi();
    if (!api) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    api.getFolder().then(setFolder).catch(() => {});
  }, []);

  const onConnect = async () => {
    const api = syncApi();
    if (!api) return;
    setBusy(true);
    try {
      const chosen = await api.selectFolder();
      if (chosen) setFolder(chosen);
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    const api = syncApi();
    if (!api) return;
    await api.clearFolder();
    setFolder(null);
    setLast(null);
  };

  const onSyncNow = async () => {
    const api = syncApi();
    if (!api) return;
    setBusy(true);
    try {
      setLast(await api.now());
    } finally {
      setBusy(false);
    }
  };

  const connected = !!folder;

  return (
    <SettingsGroup
      title="Device Sync"
      description="Sync your workspace with the Cairn mobile companion app through a shared cloud folder (iCloud Drive, Dropbox, or Syncthing). Requires the mobile app installed on your phone — there's nothing to sync with otherwise. Offline-first: only append-only oplog files transit the folder, never the database."
    >
      <SettingsRow label="Shared sync folder" description="Pick the SAME folder your phone connects to.">
        {connected ? (
          <Button variant="ghost" size="sm" onClick={onDisconnect} disabled={busy}>
            Disconnect
          </Button>
        ) : (
          <Button variant="default" size="sm" onClick={onConnect} disabled={busy}>
            <FolderOpen size={13} className="mr-1.5" />
            Choose folder…
          </Button>
        )}
      </SettingsRow>

      {connected && (
        <div className="mt-4 p-4 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] space-y-4 animate-fade-in">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} className="text-[var(--success)] shrink-0" />
            <span className="text-sm font-mono text-[var(--text-primary)] break-all select-all">{folder}</span>
          </div>

          <hr className="border-[var(--border)] opacity-30" />

          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
                <FolderSync size={13} className="text-[var(--accent)]" />
                Sync now
              </div>
              <p className="text-[10px] text-[var(--text-tertiary)] mt-0.5 max-w-sm">
                Publishes this device&apos;s changes and pulls the phone&apos;s. Runs automatically in
                the background too.
              </p>
            </div>
            <Button variant="default" size="sm" onClick={onSyncNow} disabled={busy}>
              <RefreshCw size={12} className={cn("mr-1.5", busy && "animate-spin")} />
              Sync now
            </Button>
          </div>

          {last && last.connected && (
            <div className="grid grid-cols-3 gap-2 text-center">
              <Stat label="Sent" value={last.seeded + last.drained} />
              <Stat label="Received" value={last.peerOpsApplied} />
              <Stat label="Conflicts" value={last.conflictCopies} />
            </div>
          )}
        </div>
      )}

      {!connected && (
        <div className="flex gap-2.5 p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] opacity-80 mt-4">
          <AlertCircle size={14} className="text-[var(--text-tertiary)] mt-0.5 shrink-0" />
          <p className="text-[10px] text-[var(--text-tertiary)] leading-normal">
            <strong className="text-[var(--text-secondary)]">You need the Cairn mobile app installed</strong> for
            this to do anything — Device Sync exchanges changes with your phone, not another desktop. The mobile
            app is currently a build-it-yourself companion (see the docs). Once connected, choose a cloud-synced
            folder shared with your phone: on first sync your entire existing workspace is seeded to the folder;
            after that only changes are exchanged. Conflicting edits are kept as a &quot;conflicted copy&quot;
            note — never silently lost.
          </p>
        </div>
      )}
    </SettingsGroup>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="p-2 rounded-lg border border-[var(--border)] bg-[var(--surface-3)]">
      <div className="text-lg font-bold text-[var(--text-primary)]">{value}</div>
      <div className="text-[10px] text-[var(--text-tertiary)] uppercase tracking-wide">{label}</div>
    </div>
  );
}
