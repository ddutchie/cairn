"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  RefreshCw,
  Loader2,
  Check,
  Download,
  ArrowUpCircle,
  WifiOff,
  Search,
  SlashSquare,
} from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import type { RegistryFetchResult, RegistryCommandEntry, CustomSlashCommand } from "@/types";

const inputCls =
  "w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm pl-8 pr-3 py-2 focus:outline-none";

const SCOPE_LABEL: Record<string, string> = {
  chat: "Chat",
  agent: "Agent",
  both: "Chat + Agent",
};

/**
 * True when the installed row differs from the manifest entry — i.e. an update
 * is available. Commands have no version column, so we diff the actual fields.
 */
function isOutdated(installed: CustomSlashCommand, entry: RegistryCommandEntry): boolean {
  const d = entry.definition;
  return (
    installed.name !== d.name ||
    installed.description !== (d.description ?? "") ||
    installed.insertText !== d.insertText ||
    installed.scope !== d.scope
  );
}

/**
 * Browse Community Commands — the one-click installer for community-contributed
 * slash commands from the cairn-community catalog. Fetches the manifest
 * (cache-first, refreshable), lists commands with search + category filters, and
 * installs a chosen command workspace-globally (source: "community").
 */
export function BrowseCommandsModal({ onClose }: { onClose: () => void }) {
  const { customCommands, activeWorkspaceId, installCommunityCommand } = useCairnStore(
    useShallow((s) => ({
      customCommands: s.customCommands,
      activeWorkspaceId: s.activeWorkspaceId,
      installCommunityCommand: s.installCommunityCommand,
    }))
  );

  const [result, setResult] = useState<RegistryFetchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const load = useCallback(async (force: boolean) => {
    const reg = window.electron?.registry;
    if (!reg) {
      setLoading(false);
      return;
    }
    if (force) setRefreshing(true);
    else setLoading(true);
    try {
      const r = force ? await reg.refresh() : await reg.fetch();
      setResult(r as RegistryFetchResult);
    } catch (err) {
      setResult({
        manifest: { version: 1, updatedAt: "", mcpServers: [], services: [], commands: [] },
        fromCache: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false); // eslint-disable-line react-hooks/set-state-in-effect
  }, [load]);

  const commands: RegistryCommandEntry[] = useMemo(
    () => result?.manifest.commands ?? [],
    [result]
  );

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const c of commands) if (c.category) set.add(c.category);
    return [...set].sort();
  }, [commands]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return commands.filter((c) => {
      if (activeCategory && c.category !== activeCategory) return false;
      if (!q) return true;
      return (
        c.definition.name.toLowerCase().includes(q) ||
        c.blurb.toLowerCase().includes(q) ||
        (c.definition.description ?? "").toLowerCase().includes(q) ||
        (c.category ?? "").toLowerCase().includes(q) ||
        c.tags.some((t) => t.includes(q))
      );
    });
  }, [commands, query, activeCategory]);

  // Installed state, keyed by communityId (== the connector entry id).
  const installedRow = useCallback(
    (entry: RegistryCommandEntry): CustomSlashCommand | undefined =>
      customCommands.find(
        (c) => c.workspaceId === activeWorkspaceId && c.communityId === entry.id
      ),
    [customCommands, activeWorkspaceId]
  );

  const runInstall = useCallback(
    async (entry: RegistryCommandEntry) => {
      setInstalling(entry.id);
      setInstallError(null);
      try {
        await installCommunityCommand(entry);
      } catch (err) {
        setInstallError(err instanceof Error ? err.message : "Install failed.");
      } finally {
        setInstalling(null);
      }
    },
    [installCommunityCommand]
  );

  return (
    <ModalShell
      onClose={onClose}
      size="lg"
      scrollable
      title={
        <span className="flex items-center gap-2">
          <SlashSquare size={16} /> Browse Community Commands
        </span>
      }
      description="Install community-contributed slash commands into this workspace."
    >
      {/* Toolbar: search + categories + refresh */}
      <div className="flex flex-col gap-3 pb-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
            />
            <input
              className={inputCls}
              placeholder="Search commands…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load(true)}
            disabled={refreshing}
            title="Refresh from the registry"
          >
            {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Refresh
          </Button>
        </div>

        {categories.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <TagChip label="All" active={activeCategory === null} onClick={() => setActiveCategory(null)} />
            {categories.map((cat) => (
              <TagChip
                key={cat}
                label={cat}
                active={activeCategory === cat}
                onClick={() => setActiveCategory(cat)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Provenance / error banner */}
      {result?.error && (
        <div className="mt-3 flex items-center gap-2 text-[0.714rem] text-[var(--text-tertiary)]">
          <WifiOff size={12} />
          {result.fromCache
            ? "Showing the cached catalog — couldn't reach the registry."
            : `Couldn't load the registry: ${result.error}`}
        </div>
      )}
      {installError && (
        <div className="mt-3 text-[0.714rem] text-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] rounded px-3 py-2">
          {installError}
        </div>
      )}

      {/* List */}
      <div className="mt-3 flex flex-col gap-2 min-h-[8rem]">
        {loading ? (
          <div className="flex items-center justify-center py-10 text-[var(--text-tertiary)]">
            <Loader2 size={18} className="animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-[var(--text-tertiary)] py-10 text-center border border-dashed border-[var(--border)] rounded-lg">
            {commands.length === 0 ? "No community commands available." : "No matches."}
          </p>
        ) : (
          filtered.map((entry) => {
            const installed = installedRow(entry);
            const updatable = installed !== undefined && isOutdated(installed, entry);
            const busy = installing === entry.id;
            return (
              <div
                key={entry.id}
                className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"
              >
                <div
                  className="shrink-0 rounded-md p-1.5"
                  style={{
                    background: entry.brandColor
                      ? `color-mix(in srgb, ${entry.brandColor} 14%, transparent)`
                      : "var(--surface-2, transparent)",
                    color: entry.brandColor || "var(--text-secondary)",
                  }}
                >
                  <SlashSquare size={22} />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-[var(--text-primary)] font-mono">
                      /{entry.definition.name}
                    </span>
                    <span className="text-[0.65rem] uppercase tracking-wide text-[var(--text-tertiary)] border border-[var(--border)] rounded px-1 py-px">
                      {SCOPE_LABEL[entry.definition.scope] ?? entry.definition.scope}
                    </span>
                    {entry.category && (
                      <span className="text-[0.65rem] text-[var(--text-tertiary)]">{entry.category}</span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{entry.blurb}</p>
                  <p className="text-[0.65rem] text-[var(--text-tertiary)] mt-1 font-mono line-clamp-2">
                    {entry.definition.insertText}
                  </p>
                </div>

                <div className="shrink-0">
                  {installed !== undefined && !updatable ? (
                    <span className="inline-flex items-center gap-1 text-[0.714rem] text-[var(--success,var(--accent))]">
                      <Check size={13} /> Installed
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant={updatable ? "outline" : "default"}
                      disabled={busy || !activeWorkspaceId}
                      onClick={() => void runInstall(entry)}
                    >
                      {busy ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : updatable ? (
                        <ArrowUpCircle size={12} />
                      ) : (
                        <Download size={12} />
                      )}
                      {updatable ? "Update" : "Install"}
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <p className="mt-4 text-[0.65rem] text-[var(--text-tertiary)]">
        Installed commands are added to this workspace and appear when you type{" "}
        <span className="font-mono">/</span> in a chat or agent input. Manage them under{" "}
        <strong>Your commands</strong>.
      </p>
    </ModalShell>
  );
}

function TagChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "text-[0.65rem] rounded-full px-2 py-0.5 border transition-colors",
        active
          ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] text-[var(--text-primary)]"
          : "border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
      )}
    >
      {label}
    </button>
  );
}
