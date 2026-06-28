"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Check, Server, Globe, Sparkles, Loader2, CheckCircle, XCircle } from "lucide-react";
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
          setState(await onTest());
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
      <HeaderEditor rows={rows} onChange={setRows} />
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={!valid} onClick={() => onSave({ id: initial?.id, name: name.trim(), description: description.trim() || undefined, baseUrl: baseUrl.trim(), transport, enabled: initial?.enabled ?? false, source: initial?.source ?? "manual" }, rows)}>
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

  useEffect(() => {
    if (activeWorkspaceId) fetchTools(activeWorkspaceId);
  }, [activeWorkspaceId, fetchTools]);

  // Persist secret-header values to the OS keychain, replacing the row value
  // with the returned secret:// ref before saving the config.
  const resolveHeaders = useCallback(async (toolId: string, rows: HeaderRow[]): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const row of rows) {
      if (!row.name.trim()) continue;
      if (row.isSecret && row.value && !row.value.startsWith("secret://")) {
        // A freshly-entered secret value — store it and keep only the ref.
        try {
          const ref = await window.electron?.secrets.set(toolId, row.name.trim(), row.value);
          out[row.name.trim()] = (ref as string) ?? `secret://${toolId}/${row.name.trim()}`;
        } catch {
          out[row.name.trim()] = row.value;
        }
      } else {
        out[row.name.trim()] = row.value;
      }
    }
    return out;
  }, []);

  const handleSaveMcp = useCallback(
    async (s: Partial<McpServerConfig>, rows: HeaderRow[]) => {
      const toolId = s.id ?? id();
      const headers = await resolveHeaders(toolId, rows);
      await saveMcpServer({ ...s, id: toolId, workspaceId: activeWorkspaceId ?? undefined, headers });
      setAddingMcp(false);
      setEditingMcp(null);
    },
    [activeWorkspaceId, resolveHeaders, saveMcpServer]
  );

  const handleSaveSvc = useCallback(
    async (s: Partial<CustomServiceConfig>, rows: HeaderRow[]) => {
      const toolId = s.id ?? id();
      const headers = await resolveHeaders(toolId, rows);
      await saveCustomService({ ...s, id: toolId, workspaceId: activeWorkspaceId ?? undefined, headers });
      setAddingSvc(false);
      setEditingSvc(null);
    },
    [activeWorkspaceId, resolveHeaders, saveCustomService]
  );

  return (
    <>
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
              onToggle={(v) => saveMcpServer({ ...server, enabled: v })}
              onEdit={() => setEditingMcp(server.id)}
              onDelete={() => deleteMcpServer(server.id)}
            >
              <TestButton
                onTest={async () => {
                  const r = await window.electron?.tools.testMcp(server.id);
                  if (r?.ok) return { status: "ok", detail: `${r.toolCount ?? 0} tools` };
                  return { status: "error", detail: r?.error ?? "Failed" };
                }}
              />
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
              onToggle={(v) => saveCustomService({ ...svc, enabled: v })}
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
