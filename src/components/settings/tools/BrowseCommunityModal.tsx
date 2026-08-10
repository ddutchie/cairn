"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  RefreshCw,
  Loader2,
  Check,
  Download,
  ArrowUpCircle,
  KeyRound,
  ShieldCheck,
  WifiOff,
  Search,
  LogIn,
  CheckCircle,
  X,
} from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import type {
  RegistryFetchResult,
  RegistryMcpEntry,
  RegistryServiceEntry,
} from "@/types";
import { headerNeedsSecret } from "@/store/slices/tools";
import { ConnectorLogo } from "./ConnectorLogo";

const inputCls =
  "w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm pl-8 pr-3 py-2 focus:outline-none";

type Kind = "mcp" | "service";
interface CardEntry {
  kind: Kind;
  mcp?: RegistryMcpEntry;
  service?: RegistryServiceEntry;
}

function entryName(e: CardEntry): string {
  return (e.kind === "mcp" ? e.mcp!.definition.name : e.service!.definition.name);
}
function entryMeta(e: CardEntry) {
  return e.kind === "mcp" ? e.mcp! : e.service!;
}
/** Placeholder header names on a service/MCP entry that need a secret at install. */
function secretHeaderNames(e: CardEntry): string[] {
  const headers = e.kind === "mcp" ? e.mcp!.definition.headers : e.service!.definition.headers;
  return Object.entries(headers ?? {})
    .filter(([, v]) => headerNeedsSecret(v))
    .map(([k]) => k);
}
function isOAuth(e: CardEntry): boolean {
  return e.kind === "mcp"
    ? e.mcp!.definition.authMode === "oauth"
    : e.service!.definition.authMode === "oauth";
}
function baseUrlOf(e: CardEntry): string {
  if (e.kind === "mcp") return e.mcp!.definition.baseUrl;
  // Services: multi-op uses baseUrl; legacy single-op uses apiUrl.
  const d = e.service!.definition;
  return d.baseUrl ?? d.apiUrl ?? "";
}

/**
 * Browse Community — the one-click installer for the cairn-community catalog.
 * Fetches the manifest (cache-first, refreshable), lists MCP servers + HTTP
 * services with search + tag filters, and installs a chosen entry into the
 * active workspace via the tools slice (secrets prompted; OAuth connects after).
 */
export function BrowseCommunityModal({ onClose }: { onClose: () => void }) {
  const { mcpServers, customServices, installCommunityMcp, installCommunityService } =
    useCairnStore(
      useShallow((s) => ({
        mcpServers: s.mcpServers,
        customServices: s.customServices,
        installCommunityMcp: s.installCommunityMcp,
        installCommunityService: s.installCommunityService,
      }))
    );

  const [result, setResult] = useState<RegistryFetchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  // Entry currently prompting for secrets: name → the header names + values.
  const [secretPrompt, setSecretPrompt] = useState<{ entry: CardEntry; names: string[] } | null>(null);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  // Just-installed entry that still needs its required key: OAuth connect (or a
  // confirmation when its API keys were stored at install).
  const [justInstalled, setJustInstalled] = useState<{ entry: CardEntry; toolId: string; kind: Kind; oauth: boolean; connected: boolean; secretCount: number } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const load = useCallback(async (force: boolean) => {
    const reg = window.electron?.registry;
    if (!reg) { setLoading(false); return; }
    if (force) setRefreshing(true); else setLoading(true);
    try {
      const r = force ? await reg.refresh() : await reg.fetch();
      setResult(r);
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

  const entries: CardEntry[] = useMemo(() => {
    if (!result) return [];
    return [
      ...result.manifest.mcpServers.map((mcp) => ({ kind: "mcp" as const, mcp })),
      ...result.manifest.services.map((service) => ({ kind: "service" as const, service })),
    ];
  }, [result]);

  // Chips are CATEGORIES (a small fixed vocabulary), not tags — the freeform
  // tags are too many/too granular to be useful filters. Tags still feed search.
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      const cat = entryMeta(e).category;
      if (cat) set.add(cat);
    }
    return [...set].sort();
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      const meta = entryMeta(e);
      if (activeCategory && meta.category !== activeCategory) return false;
      if (!q) return true;
      return (
        entryName(e).toLowerCase().includes(q) ||
        meta.blurb.toLowerCase().includes(q) ||
        (meta.category ?? "").toLowerCase().includes(q) ||
        meta.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [entries, query, activeCategory]);

  // Installed state, keyed by communityId (== the entry definition name).
  const installedVersion = useCallback(
    (e: CardEntry): string | undefined => {
      const name = entryName(e);
      const row =
        e.kind === "mcp"
          ? mcpServers.find((m) => m.communityId === name)
          : customServices.find((c) => c.communityId === name);
      return row?.version;
    },
    [mcpServers, customServices]
  );

  const runInstall = useCallback(
    async (e: CardEntry, secrets: Record<string, string>) => {
      setInstalling(entryName(e));
      setInstallError(null);
      setJustInstalled(null);
      setConnecting(false);
      setConnectError(null);
      try {
        const toolId =
          e.kind === "mcp"
            ? await installCommunityMcp(e.mcp!, secrets)
            : await installCommunityService(e.service!, secrets);
        setSecretPrompt(null);
        setSecretValues({});
        if (isOAuth(e)) {
          // OAuth connectors need an interactive connect (browser sign-in) —
          // ask for it right after install so the user isn't left wondering
          // why the connector is "Installed" but unusable.
          const status =
            e.kind === "mcp"
              ? await window.electron?.tools.mcpAuthStatus(toolId)
              : await window.electron?.tools.serviceAuthStatus(toolId);
          setJustInstalled({
            entry: e, toolId, kind: e.kind, oauth: true,
            connected: status?.connected ?? false,
            secretCount: Object.keys(secrets).length,
          });
        } else {
          setJustInstalled({
            entry: e, toolId, kind: e.kind, oauth: false, connected: false,
            secretCount: Object.keys(secrets).length,
          });
        }
      } catch (err) {
        setInstallError(err instanceof Error ? err.message : "Install failed.");
      } finally {
        setInstalling(null);
      }
    },
    [installCommunityMcp, installCommunityService]
  );

  /** Kick off the OAuth browser flow for the just-installed connector. */
  const connectInstalled = useCallback(async () => {
    if (!justInstalled) return;
    setConnecting(true);
    setConnectError(null);
    try {
      const r =
        justInstalled.kind === "mcp"
          ? await window.electron?.tools.startMcpAuth(justInstalled.toolId)
          : await window.electron?.tools.startServiceAuth(justInstalled.toolId);
      if (r?.status === "already_authorized") {
        setConnecting(false);
        setJustInstalled((j) => (j ? { ...j, connected: true } : j));
      } else if (r?.status === "error") {
        setConnecting(false);
        setConnectError(r.error ?? "Sign-in failed");
      }
      // "redirected": browser opened — onOauthCallback flips busy off.
    } catch (err) {
      setConnecting(false);
      setConnectError(err instanceof Error ? err.message : "Sign-in failed");
    }
  }, [justInstalled]);

  // Track completion of the OAuth flow started from the post-install prompt.
  useEffect(() => {
    const off = window.electron?.tools.onOauthCallback((e) => {
      if (!justInstalled || e.serverId !== justInstalled.toolId) return;
      setConnecting(false);
      if (e.status === "authorized") {
        setConnectError(null);
        setJustInstalled((j) => (j ? { ...j, connected: true } : j));
      } else if (e.status === "error") {
        setConnectError(e.error ?? "Sign-in failed");
      }
    });
    return () => { off?.(); };
  }, [justInstalled]);

  const onInstallClick = useCallback(
    (e: CardEntry) => {
      const names = secretHeaderNames(e);
      if (names.length > 0) {
        // Needs API keys → prompt first.
        setSecretValues(Object.fromEntries(names.map((n) => [n, ""])));
        setSecretPrompt({ entry: e, names });
        return;
      }
      void runInstall(e, {});
    },
    [runInstall]
  );

  return (
    <ModalShell
      onClose={onClose}
      size="lg"
      scrollable
      title={
        <span className="flex items-center gap-2">
          <Download size={16} /> Browse Community Tools
        </span>
      }
      description="Install community-contributed MCP servers and HTTP services."
    >
      {/* Toolbar: search + tags + refresh */}
      <div className="flex flex-col gap-3 pb-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
            />
            <input
              className={inputCls}
              placeholder="Search connectors and services…"
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
              <TagChip key={cat} label={cat} active={activeCategory === cat} onClick={() => setActiveCategory(cat)} />
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

      {/* Post-install prompt: ask for the required key (OAuth connect) or confirm. */}
      {justInstalled && (
        <div className="mt-3 rounded-lg border border-[color-mix(in_srgb,var(--ok)_40%,transparent)] bg-[color-mix(in_srgb,var(--ok)_8%,transparent)] px-3 py-2 text-[0.714rem]">
          <div className="flex items-center gap-2">
            <Check size={13} className="text-[var(--ok)] shrink-0" />
            <span className="text-[var(--text-primary)] font-medium">
              {entryName(justInstalled.entry)} installed
              {justInstalled.secretCount > 0 ? " — API key saved to your keychain" : ""}.
            </span>
            {justInstalled.oauth && !justInstalled.connected && !connecting && (
              <Button variant="outline" size="sm" className="ml-auto" onClick={() => void connectInstalled()}>
                <LogIn size={11} /> Connect now
              </Button>
            )}
            {justInstalled.oauth && justInstalled.connected && (
              <span className="flex items-center gap-1 text-[var(--ok)] ml-auto">
                <CheckCircle size={11} /> Connected
              </span>
            )}
            {justInstalled.oauth && !justInstalled.connected && connecting && (
              <span className="flex items-center gap-1 text-[var(--text-tertiary)] ml-auto">
                <Loader2 size={11} className="animate-spin" /> Waiting for browser…
              </span>
            )}
            <button
              type="button"
              onClick={() => { setJustInstalled(null); setConnecting(false); setConnectError(null); }}
              className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
              aria-label="Dismiss"
            >
              <X size={12} />
            </button>
          </div>
          {justInstalled.oauth && !justInstalled.connected && (
            <p className="text-[var(--text-tertiary)] mt-1">
              Connect your account so this connector can call external tools. After connecting, enable it and attach it to a project under MCP Servers / Custom HTTP Services.
            </p>
          )}
          {connectError && (
            <p className="text-[var(--danger)] mt-1 flex items-center gap-1">
              <WifiOff size={11} /> {connectError}
            </p>
          )}
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
            {entries.length === 0 ? "No community tools available." : "No matches."}
          </p>
        ) : (
          filtered.map((e) => {
            const meta = entryMeta(e);
            const name = entryName(e);
            const installed = installedVersion(e);
            const updatable = installed !== undefined && installed !== meta.version;
            const busy = installing === name;
            return (
              <div
                key={`${e.kind}:${name}`}
                className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"
              >
                <div className="shrink-0">
                  <ConnectorLogo iconSvg={meta.iconSvg} kind={e.kind} color={meta.brandColor} size={36} />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-[var(--text-primary)]">{name}</span>
                    <span className="text-[0.65rem] uppercase tracking-wide text-[var(--text-tertiary)] border border-[var(--border)] rounded px-1 py-px">
                      {e.kind === "mcp" ? "MCP" : "HTTP"}
                    </span>
                    {isOAuth(e) && (
                      <span className="inline-flex items-center gap-1 text-[0.65rem] text-[var(--text-tertiary)]">
                        <ShieldCheck size={11} /> OAuth
                      </span>
                    )}
                    {secretHeaderNames(e).length > 0 && (
                      <span className="inline-flex items-center gap-1 text-[0.65rem] text-[var(--text-tertiary)]">
                        <KeyRound size={11} /> API key
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{meta.blurb}</p>
                  <p className="text-[0.65rem] text-[var(--text-tertiary)] mt-1 truncate font-mono">
                    {baseUrlOf(e)}
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
                      disabled={busy}
                      onClick={() => onInstallClick(e)}
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

      {/* Secret prompt (when the entry has <API_KEY> placeholders) */}
      {secretPrompt && (
        <div className="mt-4 rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--accent)_5%,var(--surface))] p-3">
          <div className="flex items-center gap-2 mb-2">
            <KeyRound size={13} className="text-[var(--accent)]" />
            <span className="text-sm font-semibold text-[var(--text-primary)]">
              {entryName(secretPrompt.entry)} needs an API key
            </span>
          </div>
          <p className="text-[0.714rem] text-[var(--text-tertiary)] mb-3">
            Stored securely in your OS keychain — never written to the app database or sent to the model.
            {entryMeta(secretPrompt.entry).homepage && (
              <>
                {" "}
                <a
                  href={entryMeta(secretPrompt.entry).homepage}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--accent)] underline"
                >
                  Get a key
                </a>
              </>
            )}
          </p>
          {secretPrompt.names.map((n) => (
            <div key={n} className="mb-2">
              <label className="text-[0.643rem] uppercase tracking-widest text-[var(--text-tertiary)] block mb-1">
                {n}
              </label>
              <input
                type="password"
                className="w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 focus:outline-none"
                value={secretValues[n] ?? ""}
                onChange={(ev) => setSecretValues((s) => ({ ...s, [n]: ev.target.value }))}
                autoComplete="off"
              />
            </div>
          ))}
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="ghost" size="sm" onClick={() => { setSecretPrompt(null); setSecretValues({}); }}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={installing !== null || secretPrompt.names.some((n) => !secretValues[n]?.trim())}
              onClick={() => void runInstall(secretPrompt.entry, secretValues)}
            >
              {installing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              Install
            </Button>
          </div>
        </div>
      )}

      <p className="mt-4 text-[0.65rem] text-[var(--text-tertiary)]">
        Installed tools are added <strong>disabled</strong> — review them under MCP Servers / Custom
        HTTP Services, then enable (and, for OAuth, connect) and attach per-project.
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
