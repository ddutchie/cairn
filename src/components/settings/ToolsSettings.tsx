"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Check, Server, Globe, Sparkles, Loader2, CheckCircle, XCircle, LogIn, LogOut, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { id, cn } from "@/lib/utils";
import type { McpServerConfig, CustomServiceConfig } from "@/types";
import { SettingsGroup } from "./shared";
import { ToolBuilderModal } from "./ToolBuilderModal";

// ── Secret-aware header editor ──────────────────────────────────────────────
//
// Header values that look like a secret placeholder (or an existing secret://
// ref) are rendered as a masked "API key" field with a set/not-set indicator.
// The real value is written via window.electron.secrets.set (returns a
// secret:// ref) — never stored in the config literally.

interface HeaderRow {
  name: string;
  value: string;
  isSecret: boolean;
}

const PLACEHOLDER_RE = /<API_KEY>|YOUR_API_KEY|<ACCESS_TOKEN>|<TOKEN>/;
function looksSecret(value: string): boolean {
  return PLACEHOLDER_RE.test(value) || value.startsWith("secret://");
}

/**
 * Heuristic for "this header value is a credential" — used so a token typed
 * into a normal-looking header is still stored in the keychain rather than
 * persisted as plaintext config.
 */
function looksLikeCredential(name: string, value: string): boolean {
  if (!value.trim()) return false;
  if (value.startsWith("secret://")) return false;
  const n = name.toLowerCase();
  if (n === "authorization" || /api[_-]?key|token|secret|access[_-]?key/.test(n)) return true;
  if (/^bearer\s+\S/i.test(value)) return true;
  return false;
}

function headersToRows(headers?: Record<string, string>): HeaderRow[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({
    name,
    value,
    isSecret: looksSecret(value),
  }));
}

const inputCls =
  "w-full rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] text-sm px-3 py-1.5 focus:outline-none";
const labelCls =
  "text-[0.714rem] font-semibold uppercase tracking-widest text-[var(--text-tertiary)] block mb-1";

function HeaderEditor({
  rows,
  onChange,
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
}) {
  return (
    <div className="space-y-2">
      <label className={labelCls}>Headers</label>
      {rows.map((row, i) => (
        <div key={i} className="flex gap-2 items-center">
          <input
            value={row.name}
            onChange={(e) => onChange(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
            placeholder="Header-Name"
            className={cn(inputCls, "flex-1 font-mono")}
          />
          <input
            value={row.value}
            type={row.isSecret && row.value.startsWith("secret://") ? "password" : "text"}
            onChange={(e) =>
              onChange(rows.map((r, j) => (j === i ? { ...r, value: e.target.value, isSecret: looksSecret(e.target.value) } : r)))
            }
            placeholder={row.isSecret ? "secret value" : "value"}
            className={cn(inputCls, "flex-1", row.isSecret && "font-mono")}
          />
          <button
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            aria-label="Remove header"
            className="text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-colors p-1"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <Button variant="ghost" size="xs" onClick={() => onChange([...rows, { name: "", value: "", isSecret: false }])}>
        <Plus size={11} /> Add header
      </Button>
    </div>
  );
}

// ── Test connection button ───────────────────────────────────────────────────

type TestState = { status: "idle" | "testing" | "ok" | "error"; detail?: string };

function TestButton({ onTest }: { onTest: () => Promise<TestState> }) {
  const [state, setState] = useState<TestState>({ status: "idle" });
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={state.status === "testing"}
        onClick={async () => {
          setState({ status: "testing" });
          try {
            setState(await onTest());
          } catch (err) {
            setState({ status: "error", detail: err instanceof Error ? err.message : "Test failed" });
          }
        }}
      >
        {state.status === "testing" ? <Loader2 size={12} className="animate-spin" /> : null}
        Test connection
      </Button>
      {state.status === "ok" && (
        <span className="flex items-center gap-1 text-[0.714rem] text-[var(--success)]">
          <CheckCircle size={12} /> {state.detail ?? "OK"}
        </span>
      )}
      {state.status === "error" && (
        <span className="flex items-center gap-1 text-[0.714rem] text-[var(--danger)] truncate max-w-[16rem]" title={state.detail}>
          <XCircle size={12} /> {state.detail ?? "Failed"}
        </span>
      )}
    </div>
  );
}
// ── MCP OAuth sign-in control ────────────────────────────────────────────────

function McpAuthButton({ serverId }: { serverId: string }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await window.electron?.tools.mcpAuthStatus(serverId);
    setConnected(r?.connected ?? false);
  }, [serverId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    // Refresh when an OAuth callback for this server completes.
    const off = window.electron?.tools.onOauthCallback((e) => {
      if (e.serverId && e.serverId !== serverId) return;
      setBusy(false);
      if (e.status === "authorized") {
        setError(null);
        void refresh();
      } else if (e.status === "error") {
        setError(e.error ?? "Sign-in failed");
      }
    });
    return () => { off?.(); };
  }, [serverId, refresh]);

  const signIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await window.electron?.tools.startMcpAuth(serverId);
      if (r?.status === "already_authorized") {
        setBusy(false);
        void refresh();
      } else if (r?.status === "error") {
        setBusy(false);
        setError(r.error ?? "Sign-in failed");
      }
      // "redirected": browser opened; wait for onOauthCallback to flip busy off.
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Sign-in failed");
    }
  }, [serverId, refresh]);

  const signOut = useCallback(async () => {
    await window.electron?.tools.signOutMcp(serverId);
    setError(null);
    void refresh();
  }, [serverId, refresh]);

  return (
    <div className="flex items-center gap-2">
      {connected ? (
        <>
          <span className="flex items-center gap-1 text-[0.714rem] text-[var(--success)]">
            <CheckCircle size={12} /> Connected
          </span>
          <Button variant="outline" size="sm" onClick={() => void signOut()}>
            <LogOut size={12} /> Sign out
          </Button>
        </>
      ) : (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void signIn()}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <LogIn size={12} />}
          {busy ? "Waiting for browser…" : "Sign in"}
        </Button>
      )}
      {error && (
        <span className="flex items-center gap-1 text-[0.714rem] text-[var(--danger)] truncate max-w-[14rem]" title={error}>
          <XCircle size={12} /> {error}
        </span>
      )}
    </div>
  );
}

// ── MCP server form ────────────────────────────────────────────────────────────

function McpForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: McpServerConfig;
  onSave: (s: Partial<McpServerConfig>, headerRows: HeaderRow[]) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [transport, setTransport] = useState<"sse" | "http">(initial?.transport ?? "http");
  const [authMode, setAuthMode] = useState<"none" | "oauth">(initial?.authMode ?? "none");
  const [oauthScope, setOauthScope] = useState(initial?.oauthScope ?? "");
  const [rows, setRows] = useState<HeaderRow[]>(headersToRows(initial?.headers));

  const valid = name.trim().length > 0 && /^https?:\/\//.test(baseUrl.trim());

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border)] p-4 bg-[var(--surface-2)]">
      <div>
        <label className={labelCls}>Name *</label>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="e.g. Weather MCP" className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>Description</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this server provides" className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>Base URL *</label>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://mcp.example.com/sse" className={cn(inputCls, "font-mono")} />
      </div>
      <div>
        <label className={labelCls}>Transport</label>
        <div className="inline-flex rounded border border-[var(--border)] overflow-hidden">
          {(["http", "sse"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTransport(t)}
              className={cn(
                "px-3 py-1 text-xs transition-colors",
                transport === t ? "bg-[var(--accent)] text-[var(--accent-fg)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-3)]"
              )}
            >
              {t === "http" ? "streamable-HTTP" : "SSE"}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className={labelCls}>Authentication</label>
        <div className="inline-flex rounded border border-[var(--border)] overflow-hidden">
          {(["none", "oauth"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setAuthMode(m)}
              className={cn(
                "px-3 py-1 text-xs transition-colors",
                authMode === m ? "bg-[var(--accent)] text-[var(--accent-fg)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-3)]"
              )}
            >
              {m === "none" ? "Headers / API key" : "OAuth"}
            </button>
          ))}
        </div>
        {authMode === "oauth" && (
          <p className="mt-1 text-[0.714rem] text-[var(--text-tertiary)]">
            Sign in via your browser after saving. Tokens are stored in your OS keychain.
          </p>
        )}
      </div>
      {authMode === "oauth" ? (
        <div>
          <label className={labelCls}>Scope (optional)</label>
          <input value={oauthScope} onChange={(e) => setOauthScope(e.target.value)} placeholder="e.g. read:tools" className={cn(inputCls, "font-mono")} />
        </div>
      ) : (
        <HeaderEditor rows={rows} onChange={setRows} />
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={!valid} onClick={() => onSave({ id: initial?.id, name: name.trim(), description: description.trim() || undefined, baseUrl: baseUrl.trim(), transport, authMode, oauthScope: authMode === "oauth" ? (oauthScope.trim() || undefined) : undefined, enabled: initial?.enabled ?? false, source: initial?.source ?? "manual" }, authMode === "oauth" ? [] : rows)}>
          <Check size={12} /> Save server
        </Button>
      </div>
    </div>
  );
}

// ── Service form ───────────────────────────────────────────────────────────────

function ServiceForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: CustomServiceConfig;
  onSave: (s: Partial<CustomServiceConfig>, headerRows: HeaderRow[]) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [apiUrl, setApiUrl] = useState(initial?.apiUrl ?? "");
  const [method, setMethod] = useState<CustomServiceConfig["method"]>(initial?.method ?? "GET");
  const [toolDefinition, setToolDefinition] = useState(initial?.toolDefinition ?? "");
  const [responseKeys, setResponseKeys] = useState((initial?.responseKeys ?? []).join(", "));
  const [rows, setRows] = useState<HeaderRow[]>(headersToRows(initial?.headers));

  let toolDefValid = false;
  try {
    if (toolDefinition.trim()) {
      const p = JSON.parse(toolDefinition) as Record<string, unknown>;
      const fn = (p.function ?? p) as Record<string, unknown>;
      toolDefValid = typeof fn.name === "string" && fn.name.trim().length > 0;
    }
  } catch {
    toolDefValid = false;
  }
  const valid = name.trim().length > 0 && /^https?:\/\//.test(apiUrl.trim()) && toolDefValid;

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border)] p-4 bg-[var(--surface-2)]">
      <div>
        <label className={labelCls}>Name *</label>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="e.g. Web Search" className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>Description</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this API does" className={inputCls} />
      </div>
      <div className="flex gap-2">
        <div className="w-28">
          <label className={labelCls}>Method</label>
          <select value={method} onChange={(e) => setMethod(e.target.value as CustomServiceConfig["method"])} className={inputCls}>
            {(["GET", "POST", "PUT", "DELETE"] as const).map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label className={labelCls}>API URL *</label>
          <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://api.example.com/search" className={cn(inputCls, "font-mono")} />
        </div>
      </div>
      <HeaderEditor rows={rows} onChange={setRows} />
      <div>
        <label className={labelCls}>Tool definition (JSON) *</label>
        <textarea
          value={toolDefinition}
          onChange={(e) => setToolDefinition(e.target.value)}
          rows={5}
          placeholder={'{"name":"search","description":"Search the web","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}}'}
          className={cn(inputCls, "font-mono text-[0.714rem] resize-y", !toolDefValid && toolDefinition.trim() && "border-[var(--danger)]")}
        />
        {!toolDefValid && toolDefinition.trim() && (
          <p className="text-[0.714rem] text-[var(--danger)] mt-1">Must be valid JSON with a function name.</p>
        )}
      </div>
      <div>
        <label className={labelCls}>Response keys (comma-separated)</label>
        <input value={responseKeys} onChange={(e) => setResponseKeys(e.target.value)} placeholder="results, title, url, snippet" className={cn(inputCls, "font-mono")} />
        <p className="text-[0.714rem] text-[var(--text-tertiary)] mt-1">Only these keys are kept from the response (saves tokens). Leave empty to return everything.</p>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button
          size="sm"
          disabled={!valid}
          onClick={() =>
            onSave(
              {
                id: initial?.id,
                name: name.trim(),
                description: description.trim() || undefined,
                apiUrl: apiUrl.trim(),
                method,
                toolDefinition: toolDefinition.trim(),
                responseKeys: responseKeys.split(",").map((s) => s.trim()).filter(Boolean),
                enabled: initial?.enabled ?? false,
                source: initial?.source ?? "manual",
              },
              rows
            )
          }
        >
          <Check size={12} /> Save service
        </Button>
      </div>
    </div>
  );
}

// ── List row ───────────────────────────────────────────────────────────────────

function ToolRow({
  icon,
  name,
  subtitle,
  enabled,
  onToggle,
  onEdit,
  onDelete,
  children,
}: {
  icon: React.ReactNode;
  name: string;
  subtitle: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="text-[var(--text-tertiary)] flex-shrink-0">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-[var(--text-primary)] truncate">{name}</div>
          <div className="text-[0.714rem] text-[var(--text-tertiary)] truncate font-mono">{subtitle}</div>
        </div>
        <button
          onClick={() => onToggle(!enabled)}
          role="switch"
          aria-checked={enabled}
          aria-label={`Enable ${name}`}
          className={cn(
            "relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0",
            enabled ? "bg-[var(--accent)]" : "bg-[var(--surface-3)] border border-[var(--border)]"
          )}
        >
          <span className={cn("inline-block h-3.5 w-3.5 rounded-full bg-[var(--surface)] shadow-sm transition-transform", enabled ? "translate-x-4.5" : "translate-x-0.5")} />
        </button>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button variant="ghost" size="xs" onClick={onEdit}>Edit</Button>
          <Button variant="ghost" size="xs" onClick={onDelete} className="text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]">
            <Trash2 size={11} />
          </Button>
        </div>
      </div>
      {children && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}

/**
 * Expandable per-tool enable/disable checklist for an MCP server. Lists the
 * server's individual tools (fetched live) with a switch each; toggling off adds
 * the tool to the server's workspace-wide `disabledTools` list so it's hidden
 * from the AI everywhere the server is used.
 */
function McpToolList({ server }: { server: McpServerConfig }) {
  const [open, setOpen] = useState(false);
  const { state, fetchMcpTools, setMcpToolEnabled } = useCairnStore(
    useShallow((s) => ({
      state: s.mcpTools[server.id],
      fetchMcpTools: s.fetchMcpTools,
      setMcpToolEnabled: s.setMcpToolEnabled,
    }))
  );

  const disabled = new Set(server.disabledTools ?? []);
  const tools = state?.tools ?? [];
  const loading = state?.loading ?? false;

  // Fetch once when first expanded (or if a prior fetch left no data).
  useEffect(() => {
    if (open && !state) void fetchMcpTools(server.id);
  }, [open, state, fetchMcpTools, server.id]);

  const enabledCount = tools.length - tools.filter((t) => disabled.has(t.name)).length;

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface-2)]">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left"
      >
        {open ? <ChevronDown size={12} className="text-[var(--text-tertiary)] shrink-0" /> : <ChevronRight size={12} className="text-[var(--text-tertiary)] shrink-0" />}
        <span className="text-[0.786rem] text-[var(--text-secondary)]">Tools</span>
        <span className="text-[0.714rem] text-[var(--text-tertiary)]">
          {tools.length > 0 ? `${enabledCount} of ${tools.length} enabled` : "manage which tools the AI can use"}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {loading && <Loader2 size={11} className="animate-spin text-[var(--text-tertiary)]" />}
          <span
            role="button"
            tabIndex={0}
            aria-label="Refresh tool list"
            onClick={(e) => { e.stopPropagation(); void fetchMcpTools(server.id); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); void fetchMcpTools(server.id); } }}
            className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors cursor-pointer focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]"
          >
            <RefreshCw size={11} />
          </span>
        </span>
      </button>

      {open && (
        <div className="px-2.5 pb-2 pt-0.5">
          {state?.error ? (
            <p className="text-[0.714rem] text-[var(--danger)] py-1.5">{state.error}</p>
          ) : tools.length === 0 ? (
            <p className="text-[0.714rem] text-[var(--text-tertiary)] py-1.5">
              {loading ? "Loading tools…" : "No tools reported by this server."}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {tools.map((t) => {
                const isEnabled = !disabled.has(t.name);
                return (
                  <li key={t.name} className="flex items-start gap-2 py-1">
                    <div className="flex-1 min-w-0">
                      <div className="text-[0.786rem] text-[var(--text-secondary)] font-mono truncate">{t.name}</div>
                      {t.description && (
                        <div className="text-[0.714rem] text-[var(--text-tertiary)] line-clamp-2">{t.description}</div>
                      )}
                    </div>
                    <button
                      onClick={() => void setMcpToolEnabled(server.id, t.name, !isEnabled)}
                      role="switch"
                      aria-checked={isEnabled}
                      aria-label={`${isEnabled ? "Disable" : "Enable"} ${t.name}`}
                      className={cn(
                        "relative inline-flex h-4 w-7 items-center rounded-full transition-colors flex-shrink-0 mt-0.5",
                        isEnabled ? "bg-[var(--accent)]" : "bg-[var(--surface-3)] border border-[var(--border)]"
                      )}
                    >
                      <span className={cn("inline-block h-3 w-3 rounded-full bg-[var(--surface)] shadow-sm transition-transform", isEnabled ? "translate-x-3.5" : "translate-x-0.5")} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main settings component ──────────────────────────────────────────────────

export function ToolsSettings() {
  const {
    activeWorkspaceId,
    mcpServers,
    customServices,
    fetchTools,
    saveMcpServer,
    deleteMcpServer,
    saveCustomService,
    deleteCustomService,
  } = useCairnStore(
    useShallow((s) => ({
      activeWorkspaceId: s.activeWorkspaceId,
      mcpServers: s.mcpServers,
      customServices: s.customServices,
      fetchTools: s.fetchTools,
      saveMcpServer: s.saveMcpServer,
      deleteMcpServer: s.deleteMcpServer,
      saveCustomService: s.saveCustomService,
      deleteCustomService: s.deleteCustomService,
    }))
  );

  const [addingMcp, setAddingMcp] = useState(false);
  const [editingMcp, setEditingMcp] = useState<string | null>(null);
  const [addingSvc, setAddingSvc] = useState(false);
  const [editingSvc, setEditingSvc] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (activeWorkspaceId) fetchTools(activeWorkspaceId);
  }, [activeWorkspaceId, fetchTools]);

  // Persist secret-header values to the OS keychain, replacing the row value
  // with the returned secret:// ref before saving the config.
  const resolveHeaders = useCallback(
    async (toolType: "mcp" | "service", toolId: string, rows: HeaderRow[]): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const row of rows) {
        const name = row.name.trim();
        if (!name) continue;
        // Treat anything that looks like a credential as a secret, even if the
        // user didn't flag it — defense against plaintext tokens in config.
        const isSecretValue =
          (row.isSecret || looksLikeCredential(name, row.value)) && !row.value.startsWith("secret://");
        if (isSecretValue && row.value) {
          // Store in the keychain and keep ONLY the ref. If storage fails, do
          // not fall back to persisting the plaintext value — surface the error.
          const ref = await window.electron?.secrets.set(toolType, toolId, name, row.value);
          if (!ref) throw new Error(`Could not securely store the secret for "${name}". It was not saved.`);
          out[name] = ref as string;
        } else {
          out[name] = row.value;
        }
      }
      return out;
    },
    []
  );

  const handleSaveMcp = useCallback(
    async (s: Partial<McpServerConfig>, rows: HeaderRow[]) => {
      const toolId = s.id ?? id();
      setSaveError(null);
      try {
        const headers = await resolveHeaders("mcp", toolId, rows);
        await saveMcpServer({ ...s, id: toolId, workspaceId: activeWorkspaceId ?? undefined, headers });
        setAddingMcp(false);
        setEditingMcp(null);
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Failed to save server.");
      }
    },
    [activeWorkspaceId, resolveHeaders, saveMcpServer]
  );

  const handleSaveSvc = useCallback(
    async (s: Partial<CustomServiceConfig>, rows: HeaderRow[]) => {
      const toolId = s.id ?? id();
      setSaveError(null);
      try {
        const headers = await resolveHeaders("service", toolId, rows);
        await saveCustomService({ ...s, id: toolId, workspaceId: activeWorkspaceId ?? undefined, headers });
        setAddingSvc(false);
        setEditingSvc(null);
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Failed to save service.");
      }
    },
    [activeWorkspaceId, resolveHeaders, saveCustomService]
  );

  return (
    <>
      {saveError && (
        <div className="text-[0.714rem] text-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] rounded px-3 py-2">
          {saveError}
        </div>
      )}
      <SettingsGroup
        title="MCP Servers"
        description="Connect the AI to remote MCP servers (SSE or streamable-HTTP). Enable a server here, then attach it per-project from the project Overview."
      >
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-[var(--text-tertiary)]">Configured servers</h3>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => setBuilderOpen(true)}>
              <Sparkles size={12} /> Build with AI
            </Button>
            {!addingMcp && (
              <Button variant="ghost" size="sm" onClick={() => setAddingMcp(true)}>
                <Plus size={12} /> Add server
              </Button>
            )}
          </div>
        </div>

        {addingMcp && <McpForm onSave={handleSaveMcp} onCancel={() => setAddingMcp(false)} />}

        {mcpServers.length === 0 && !addingMcp && (
          <p className="text-xs text-[var(--text-tertiary)] py-4 text-center border border-dashed border-[var(--border)] rounded-lg">
            No MCP servers configured yet.
          </p>
        )}

        {mcpServers.map((server) =>
          editingMcp === server.id ? (
            <McpForm key={server.id} initial={server} onSave={handleSaveMcp} onCancel={() => setEditingMcp(null)} />
          ) : (
            <ToolRow
              key={server.id}
              icon={<Server size={15} />}
              name={server.name}
              subtitle={server.baseUrl}
              enabled={server.enabled}
              onToggle={(v) => { void saveMcpServer({ ...server, enabled: v }).catch((e) => setSaveError(e instanceof Error ? e.message : "Failed to update server.")); }}
              onEdit={() => setEditingMcp(server.id)}
              onDelete={() => deleteMcpServer(server.id)}
            >
              <div className="flex flex-col gap-2">
                {server.authMode === "oauth" ? (
                  <McpAuthButton serverId={server.id} />
                ) : (
                  <TestButton
                    onTest={async () => {
                      const r = await window.electron?.tools.testMcp(server.id);
                      if (r?.ok) return { status: "ok", detail: `${r.toolCount ?? 0} tools` };
                      return { status: "error", detail: r?.error ?? "Failed" };
                    }}
                  />
                )}
                <McpToolList server={server} />
              </div>
            </ToolRow>
          )
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Custom HTTP Services"
        description="Expose any HTTP API to the AI as a single tool. Define the request shape and which response fields to keep."
      >
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-[var(--text-tertiary)]">Configured services</h3>
          {!addingSvc && (
            <Button variant="ghost" size="sm" onClick={() => setAddingSvc(true)}>
              <Plus size={12} /> Add service
            </Button>
          )}
        </div>

        {addingSvc && <ServiceForm onSave={handleSaveSvc} onCancel={() => setAddingSvc(false)} />}

        {customServices.length === 0 && !addingSvc && (
          <p className="text-xs text-[var(--text-tertiary)] py-4 text-center border border-dashed border-[var(--border)] rounded-lg">
            No custom services configured yet.
          </p>
        )}

        {customServices.map((svc) =>
          editingSvc === svc.id ? (
            <ServiceForm key={svc.id} initial={svc} onSave={handleSaveSvc} onCancel={() => setEditingSvc(null)} />
          ) : (
            <ToolRow
              key={svc.id}
              icon={<Globe size={15} />}
              name={svc.name}
              subtitle={`${svc.method} ${svc.apiUrl}`}
              enabled={svc.enabled}
              onToggle={(v) => { void saveCustomService({ ...svc, enabled: v }).catch((e) => setSaveError(e instanceof Error ? e.message : "Failed to update service.")); }}
              onEdit={() => setEditingSvc(svc.id)}
              onDelete={() => deleteCustomService(svc.id)}
            >
              <TestButton
                onTest={async () => {
                  const r = await window.electron?.tools.testService(svc.id);
                  if (r?.ok) return { status: "ok", detail: `HTTP ${r.status ?? 200}` };
                  return { status: "error", detail: r?.error ?? `HTTP ${r?.status ?? "?"}` };
                }}
              />
            </ToolRow>
          )
        )}
      </SettingsGroup>

      {builderOpen && activeWorkspaceId && (
        <ToolBuilderModal
          workspaceId={activeWorkspaceId}
          onClose={() => {
            setBuilderOpen(false);
            if (activeWorkspaceId) fetchTools(activeWorkspaceId);
          }}
        />
      )}
    </>
  );
}
