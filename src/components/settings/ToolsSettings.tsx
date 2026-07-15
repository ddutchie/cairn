"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Server, Globe, Sparkles } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { id } from "@/lib/utils";
import type { McpServerConfig, CustomServiceConfig } from "@/types";
import { SettingsGroup } from "./shared";
import { ToolBuilderModal } from "./ToolBuilderModal";
import { type HeaderRow, looksLikeCredential } from "./tools/helpers";
import { TestButton } from "./tools/TestButton";
import { McpAuthButton } from "./tools/McpAuthButton";
import { McpForm } from "./tools/McpForm";
import { ServiceForm } from "./tools/ServiceForm";
import { ToolRow } from "./tools/ToolRow";
import { McpToolList } from "./tools/McpToolList";

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

      <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--accent)_5%,var(--surface))] px-4 py-3">
        <div className="flex items-start gap-3 min-w-0">
          <span className="text-[var(--accent)] mt-0.5"><Sparkles size={16} /></span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Build a tool with AI</h3>
            <p className="text-xs text-[var(--text-tertiary)] mt-0.5">
              Describe any API endpoint or MCP server — the AI probes it, figures out the auth and response shape, and
              creates a ready-to-enable tool (HTTP service or MCP server).
            </p>
          </div>
        </div>
        <Button size="sm" onClick={() => setBuilderOpen(true)} className="shrink-0">
          <Sparkles size={12} /> Build with AI
        </Button>
      </div>

      <SettingsGroup
        title="MCP Servers"
        description="Connect the AI to remote MCP servers (SSE or streamable-HTTP). Enable a server here, then attach it per-project from the project Overview."
      >
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-[var(--text-tertiary)]">Configured servers</h3>
          <div className="flex gap-1">
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
