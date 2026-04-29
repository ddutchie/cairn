"use client";

import React, { useState } from "react";
import { Trash2, Download, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { useCairnStore } from "@/store";
import { storage } from "@/lib/storage";
import { SettingsGroup, SettingsRow } from "./shared";

export function DataSettings({
  stats,
}: {
  stats: { workspaces: number; projects: number; notes: number; cards: number };
}) {
  const { workspaces, projects, notes, columns, cards, tags } = useCairnStore();
  const [exportDone, setExportDone] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  function handleExport() {
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
  }

  function handleReset() {
    storage.clear();
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
            <div className="text-[11px] text-[var(--text-tertiary)] mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      <SettingsRow label="Storage" description="All data is stored locally in SQLite">
        <span className="text-xs text-[var(--text-tertiary)]">SQLite</span>
      </SettingsRow>

      <SettingsRow label="Export data" description="Download your data as cairn-data.json">
        <Button variant="default" size="sm" onClick={handleExport}>
          {exportDone ? (
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

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Reset all data?</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-4 space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              This will wipe all local data including notes, tasks, and projects. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost" size="sm">Cancel</Button>
              </DialogClose>
              <Button variant="danger" size="sm" onClick={handleReset}>
                <Trash2 size={12} /> Wipe all data
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}
