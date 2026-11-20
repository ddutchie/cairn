"use client";

import React, { useEffect, useState } from "react";
import { FolderSync, FolderOpen, AlertCircle, CheckCircle2 } from "lucide-react";
import { RefreshSpin } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { SettingsGroup, SettingsRow } from "./shared";
import { openConflictModal } from "@/lib/sync-client";
import { SyncActivityPanel } from "./SyncActivityPanel";

interface SyncNowResult {
  drained: number;
  seeded: number;
  peerOpsApplied: number;
  conflictCopies: number;
  connected: boolean;
}

import { syncClient } from "@/lib/ipc/sync";
import { hasElectron } from "@/lib/ipc/client";

export function SyncSettings() {
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<SyncNowResult | null>(null);

  useEffect(() => {
    if (!hasElectron("sync")) return;
    syncClient.getFolder().then(setFolder).catch(() => {});
  }, []);

  const onConnect = async () => {
    if (!hasElectron("sync")) return;
    setBusy(true);
    try {
      const chosen = await syncClient.selectFolder();
      if (chosen) setFolder(chosen);
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    if (!hasElectron("sync")) return;
    await syncClient.clearFolder();
    setFolder(null);
    setLast(null);
  };

  // Disconnect AND delete this workspace's oplog + blobs from the shared folder.
  // Phones are told via a marker; reconnecting the same folder re-syncs it.
  const onRemove = async () => {
    if (!hasElectron("sync")) return;
    setBusy(true);
    try {
      await syncClient.removeFromFolder();
      setFolder(null);
      setLast(null);
    } finally {
      setBusy(false);
    }
  };

  const onSyncNow = async () => {
    if (!hasElectron("sync")) return;
    setBusy(true);
    try {
      setLast(await syncClient.now());
    } finally {
      setBusy(false);
    }
  };

  const connected = !!folder;

  return (
    <SettingsGroup
      title="Mobile app sync"
      description="Syncs with the Cairn mobile app through a shared cloud folder (iCloud Drive, Dropbox or Syncthing). Only change logs pass through the folder, never the database."
    >
      <SettingsRow label="Shared sync folder" description="Pick the same folder your phone syncs with.">
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
              <p className="text-xs text-[var(--text-tertiary)] mt-0.5 max-w-sm">
                Publishes this device&apos;s changes and pulls the phone&apos;s. Runs automatically in
                the background too.
              </p>
            </div>
            <Button variant="default" size="sm" onClick={onSyncNow} disabled={busy}>
              <RefreshSpin size={12} spinning={busy} className="mr-1.5" />
              Sync now
            </Button>
          </div>

          {last && last.connected && (
            <div className="grid grid-cols-3 gap-2 text-center">
              <Stat label="Sent" value={last.seeded + last.drained} />
              <Stat label="Received" value={last.peerOpsApplied} />
              <Stat label="Conflicts" value={last.conflictCopies} onClick={last.conflictCopies > 0 ? openConflictModal : undefined} />
            </div>
          )}

          {last && last.connected && last.conflictCopies > 0 && (
            <button
              type="button"
              onClick={openConflictModal}
              className="w-full text-xs font-medium text-[var(--warning)] hover:underline"
            >
              Review {last.conflictCopies} {last.conflictCopies === 1 ? "conflict" : "conflicts"}…
            </button>
          )}

          <hr className="border-[var(--border)] opacity-30" />

          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-xs font-semibold text-[var(--text-primary)]">Disconnect and remove from folder</div>
              <p className="text-xs text-[var(--text-tertiary)] mt-0.5 max-w-sm">
                Deletes this workspace&apos;s sync files (change log and images) from the folder and tells your phone it
                was removed. Your workspace here is untouched. Choose the same folder again to re-sync it.
              </p>
            </div>
            <ConfirmButton variant="ghost" size="sm" onConfirm={onRemove} disabled={busy} confirmLabel="Remove files?" showCancel>
              Remove…
            </ConfirmButton>
          </div>

          <hr className="border-[var(--border)] opacity-30" />

          <SyncActivityPanel />
        </div>
      )}

      {!connected && (
        <div className="flex gap-2.5 p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] opacity-80 mt-4">
          <AlertCircle size={14} className="text-[var(--text-tertiary)] mt-0.5 shrink-0" />
          <p className="text-xs text-[var(--text-tertiary)] leading-normal">
            <strong className="text-[var(--text-secondary)]">You need the Cairn mobile app installed</strong>{" "}
            for this to do anything — Device Sync exchanges changes with your phone, not another desktop. The mobile
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

function Stat({ label, value, onClick }: { label: string; value: number; onClick?: () => void }) {
  const inner = (
    <>
      <div className="text-lg font-bold text-[var(--text-primary)]">{value}</div>
      <div className="text-xs text-[var(--text-tertiary)]">{label}</div>
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="p-2 rounded-lg border border-[color-mix(in_srgb,var(--warning)_40%,transparent)] bg-[var(--surface-3)] hover:bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] transition-colors"
      >
        {inner}
      </button>
    );
  }
  return <div className="p-2 rounded-lg border border-[var(--border)] bg-[var(--surface-3)]">{inner}</div>;
}
