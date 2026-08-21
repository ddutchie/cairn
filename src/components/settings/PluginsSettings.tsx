"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Puzzle, FolderOpen, RefreshCw, Bot } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";

interface PluginRow {
  id: string;
  kind: "ui" | "backend" | "both";
  name: string | null;
  ui: string | null;
  disabled: boolean;
}
interface PluginList {
  devEnabled: boolean;
  root: string;
  plugins: PluginRow[];
}

type Electron = {
  plugins?: {
    list: () => Promise<PluginList>;
    setEnabled: (id: string, enabled: boolean) => Promise<{ ok: boolean }>;
    openFolder: () => Promise<{ ok: boolean }>;
    onUiChanged: (cb: () => void) => () => void;
  };
};

const KIND_LABEL: Record<PluginRow["kind"], string> = {
  ui: "UI",
  backend: "Tool",
  both: "UI + Tool",
};

export function PluginsSettings() {
  const el = (typeof window !== "undefined" ? (window as unknown as { electron?: Electron }).electron : undefined);
  const [data, setData] = useState<PluginList | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!el?.plugins) { setData({ devEnabled: false, root: "", plugins: [] }); return; }
    try { setData(await el.plugins.list()); } catch { setData({ devEnabled: false, root: "", plugins: [] }); }
  }, [el]);

  useEffect(() => { void refresh(); }, [refresh]);
  // Re-pull when the plugins dir changes (edit/add/remove on disk).
  useEffect(() => {
    if (!el?.plugins) return;
    return el.plugins.onUiChanged(() => void refresh());
  }, [el, refresh]);

  const toggle = async (row: PluginRow) => {
    if (!el?.plugins) return;
    setBusy(row.id);
    try { await el.plugins.setEnabled(row.id, row.disabled /* was disabled → enable */); await refresh(); }
    finally { setBusy(null); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Puzzle size={15} /> Plugins
          </h2>
          <p className="text-xs text-[var(--text-tertiary)] leading-relaxed max-w-lg">
            Plugins extend Cairn with new agent tools and UI. They live in your plugins folder and load
            live — add, edit, or remove one and it updates without a restart.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => el?.plugins?.openFolder()}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
          >
            <FolderOpen size={13} /> Open plugins folder
          </button>
          <button
            onClick={() => void refresh()}
            title="Refresh"
            className="flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {data && !data.devEnabled && (
        <div className="p-3 rounded-lg border border-[color-mix(in_srgb,var(--warning,#d9a441)_35%,transparent)] bg-[color-mix(in_srgb,var(--warning,#d9a441)_8%,transparent)] text-xs text-[var(--text-secondary)] leading-relaxed">
          Plugins are in <strong>developer preview</strong>. Launch Cairn with{" "}
          <code className="font-mono text-[var(--text-primary)]">CAIRN_PLUGINS_DEV=1</code> to load them.
          You can still open the folder and manage the manifest below.
        </div>
      )}

      {data && data.plugins.length === 0 ? (
        <div className="p-6 rounded-xl border border-dashed border-[var(--border)] text-center">
          <Puzzle size={20} className="mx-auto text-[var(--text-tertiary)] mb-2" />
          <div className="text-sm text-[var(--text-secondary)]">No plugins yet</div>
          <div className="text-xs text-[var(--text-tertiary)] mt-1">
            Add an entry to <code className="font-mono">plugins.yml</code> in your plugins folder.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {data?.plugins.map((row) => (
            <div
              key={row.id}
              className="flex items-center gap-3 p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-[var(--text-primary)] truncate">{row.id}</span>
                  <span className="text-[0.65rem] uppercase tracking-wide px-1.5 py-0.5 rounded bg-[var(--surface-3)] text-[var(--text-tertiary)]">
                    {KIND_LABEL[row.kind]}
                  </span>
                </div>
                <div className="text-xs text-[var(--text-tertiary)] font-mono truncate mt-0.5">
                  {row.ui ?? row.name ?? ""}
                </div>
              </div>
              <Toggle
                checked={!row.disabled}
                disabled={busy === row.id || !data.devEnabled}
                onCheckedChange={() => void toggle(row)}
              />
            </div>
          ))}
        </div>
      )}

      {/* Toward a plugin agent — a signpost for the next step. */}
      <div className="p-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] flex items-start gap-2.5">
        <Bot size={15} className="text-[var(--text-tertiary)] mt-0.5 shrink-0" />
        <div className="text-xs text-[var(--text-tertiary)] leading-relaxed">
          <span className="text-[var(--text-secondary)] font-medium">Plugin agent (coming soon).</span>{" "}
          A guided agent that helps you write, install, and debug plugins from a description —
          e.g. “a cat emoji that bounces around the screen” or “a tool that summarises the current note”.
        </div>
      </div>
    </div>
  );
}
