"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Check,
  Download,
  ArrowUpCircle,
  SlashSquare,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { CatalogBrowserShell } from "@/components/ui/catalog-browser-shell";
import { Button } from "@/components/ui/button";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { RegistryFetchResult, RegistryCommandEntry, CustomSlashCommand } from "@/types";

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
  // Two-step confirm when updating an already-installed command: the update
  // overwrites local values with the registry's, so the first click arms
  // ("Confirm update") and the second fires. Auto-disarms after 4s.
  const [armedUpdateId, setArmedUpdateId] = useState<string | null>(null);
  const armedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (armedTimer.current) clearTimeout(armedTimer.current);
  }, []);

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
      if (armedTimer.current) clearTimeout(armedTimer.current);
      armedTimer.current = null;
      setArmedUpdateId(null);
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
    <CatalogBrowserShell
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <SlashSquare size={16} /> Browse Community Commands
        </span>
      }
      description="Install community-contributed slash commands into this workspace."
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="Search commands…"
      refreshing={refreshing}
      onRefresh={() => void load(true)}
      categories={categories}
      activeCategory={activeCategory}
      onCategoryChange={setActiveCategory}
      registryError={result?.error}
      fromCache={result?.fromCache}
      installError={installError}
      loading={loading}
      hasEntries={commands.length > 0}
      hasResults={filtered.length > 0}
      emptyText="No community commands available."
      belowList={
        <p className="mt-4 text-[0.65rem] text-[var(--text-tertiary)]">
          Installed commands are added to this workspace and appear when you type{" "}
          <span className="font-mono">/</span> in a chat or agent input. Manage them under{" "}
          <strong>Your commands</strong>.
        </p>
      }
    >
      {filtered.map((entry) => {
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
                      title={updatable && armedUpdateId === entry.id ? "Click again — your local edits will be replaced by the community version" : undefined}
                      onClick={() => {
                        if (updatable && armedUpdateId !== entry.id) {
                          if (armedTimer.current) clearTimeout(armedTimer.current);
                          setArmedUpdateId(entry.id);
                          armedTimer.current = setTimeout(() => {
                            armedTimer.current = null;
                            setArmedUpdateId(null);
                          }, 4000);
                          return;
                        }
                        void runInstall(entry);
                      }}
                    >
                      {busy ? (
                        <Spinner size={12} />
                      ) : updatable ? (
                        <ArrowUpCircle size={12} />
                      ) : (
                        <Download size={12} />
                      )}
                      {updatable ? (armedUpdateId === entry.id ? "Confirm update" : "Update") : "Install"}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
    </CatalogBrowserShell>
  );
}
