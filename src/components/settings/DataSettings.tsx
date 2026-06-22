"use client";

import React, { useState } from "react";
import { Trash2, Download, CheckCircle, FolderOpen, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { storage } from "@/lib/storage";
import { SettingsGroup, SettingsRow } from "./shared";

export function DataSettings({
  stats,
}: {
  stats: { workspaces: number; projects: number; notes: number; cards: number };
}) {
  const { workspaces, projects, notes, columns, cards, tags } = useCairnStore(useShallow((s) => ({ workspaces: s.workspaces, projects: s.projects, notes: s.notes, columns: s.columns, cards: s.cards, tags: s.tags })));
  const [exportDone, setExportDone] = useState(false);
  const [exportError, setExportError] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetConfirm, setResetConfirm] = useState("");

  function handleExport() {
    try {
      setExportError(false);
      const data = { workspaces, projects, notes, columns, cards, tags, exportedAt: new Date().toISOString() };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cairn-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setExportDone(true);
      setTimeout(() => setExportDone(false), 3000);
    } catch {
      setExportError(true);
    }
  }

  async function handleReset() {
    storage.clear();
    await window.electron?.resetAllData();
    // relaunch is called inside the IPC handler; if running in browser dev, fallback
    window.location.reload();
  }

  return (
    <SettingsGroup title="Data" description="Manage your local Cairn data">
      <div className="grid grid-cols-4 gap-3 mb-2">
        {Object.entries(stats).map(([label, count]) => (
          <div
            key={label}
            className="p-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-center"
          >
            <div className="text-xl font-bold text-[var(--text-primary)]">{count}</div>
            <div className="text-[0.786rem] text-[var(--text-tertiary)] mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      <SettingsRow label="Storage" description="All data is stored locally in SQLite">
        <span className="text-xs text-[var(--text-tertiary)]">SQLite</span>
      </SettingsRow>

      <SettingsRow label="Assets folder" description="Open the folder containing all pasted images">
        <Button variant="default" size="sm" onClick={() => window.electron?.revealAssets()}>
          <FolderOpen size={12} /> {window.electron?.platform === "darwin" ? "Show in Finder" : window.electron?.platform === "win32" ? "Show in Explorer" : "Open folder"}
        </Button>
      </SettingsRow>

      <SettingsRow label="Export data" description="Download your data as cairn-data.json">
        <Button variant="default" size="sm" onClick={handleExport}>
          {exportError ? (
            <><AlertCircle size={12} className="text-[var(--danger)]" /> Failed</>
          ) : exportDone ? (
            <><CheckCircle size={12} className="text-[var(--success)]" /> Exported</>
          ) : (
            <><Download size={12} /> Export</>
          )}
        </Button>
      </SettingsRow>

      <SettingsRow label="Reset data" description="Wipe all local data. Cannot be undone.">
        <Button variant="danger" size="sm" onClick={() => setResetOpen(true)}>
          <Trash2 size={12} /> Reset
        </Button>
      </SettingsRow>

      <Dialog open={resetOpen} onOpenChange={(v) => { setResetOpen(v); if (!v) setResetConfirm(""); }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Reset all data?</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-4 space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              This will wipe all local data including notes, tasks, and projects. This cannot be undone.
            </p>
            <p className="text-xs text-[var(--text-tertiary)]">
              Type <strong className="text-[var(--danger)]">DELETE</strong> to confirm:
            </p>
            <input
              type="text"
              value={resetConfirm}
              onChange={(e) => setResetConfirm(e.target.value)}
              autoFocus
              aria-label="Type DELETE to confirm deletion"
              className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] focus:outline-none focus:border-[var(--danger)]"
            />
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost" size="sm">Cancel</Button>
              </DialogClose>
              <Button variant="danger" size="sm" onClick={handleReset} disabled={resetConfirm !== "DELETE"}>
                <Trash2 size={12} /> Wipe all data
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}
