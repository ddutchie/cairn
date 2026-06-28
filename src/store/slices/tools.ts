/**
 * External Tools slice.
 *
 * Workspace-scoped MCP servers + custom HTTP services the AI chat/agent can
 * use, plus per-project attachment flags. Persisted via the tools:* IPC
 * channels (SQLite tables mcp_servers / custom_services / tool_attachments).
 *
 * This slice owns CRUD + local cache only. Tool execution happens in the
 * Electron main process during the chat/agent loop.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { McpServerConfig, CustomServiceConfig, ToolAttachment, ToolType } from "@/types";

/** A single tool exposed by an MCP server (raw name + description). */
export interface McpToolInfo {
  name: string;
  description?: string;
}

/** Per-server tool-listing state for the Settings checklist. */
export interface McpToolsState {
  loading: boolean;
  tools: McpToolInfo[];
  error?: string;
}

export interface ToolsSlice {
  mcpServers: McpServerConfig[];
  customServices: CustomServiceConfig[];
  /** Attachments for the currently-loaded project (keyed by project on fetch). */
  toolAttachments: ToolAttachment[];
  /** Live tool listings per MCP server id, fetched lazily for the checklist. */
  mcpTools: Record<string, McpToolsState>;

  fetchTools: (workspaceId: string) => Promise<void>;
  saveMcpServer: (server: Partial<McpServerConfig>) => Promise<void>;
  deleteMcpServer: (id: string) => Promise<void>;
  saveCustomService: (service: Partial<CustomServiceConfig>) => Promise<void>;
  deleteCustomService: (id: string) => Promise<void>;

  /** Fetch (and cache) the individual tools of an MCP server for the checklist. */
  fetchMcpTools: (serverId: string) => Promise<void>;
  /** Enable/disable a single tool of an MCP server (workspace-wide). */
  setMcpToolEnabled: (serverId: string, toolName: string, enabled: boolean) => Promise<void>;

  fetchToolAttachments: (projectId: string) => Promise<void>;
  setToolAttachment: (projectId: string, toolType: ToolType, toolId: string, enabled: boolean) => Promise<void>;
  clearToolAttachment: (projectId: string, toolType: ToolType, toolId: string) => Promise<void>;
}

export const createToolsSlice: StateCreator<CairnStore, [], [], ToolsSlice> = (set, get) => ({
  mcpServers: [],
  customServices: [],
  toolAttachments: [],
  mcpTools: {},

  async fetchTools(workspaceId) {
    if (typeof window === "undefined" || !window.electron?.tools) return;
    try {
      const [mcpServers, customServices] = await Promise.all([
        window.electron.tools.listMcpServers(workspaceId) as Promise<McpServerConfig[]>,
        window.electron.tools.listServices(workspaceId) as Promise<CustomServiceConfig[]>,
      ]);
      // Guard against a late response overwriting a newer active workspace.
      if (get().activeWorkspaceId && get().activeWorkspaceId !== workspaceId) return;
      set({ mcpServers, customServices });
    } catch (err) {
      console.error("[tools] fetchTools error", err);
    }
  },

  async saveMcpServer(server) {
    if (typeof window === "undefined" || !window.electron?.tools) return;
    const saved = await window.electron.tools.saveMcpServer(server) as McpServerConfig;
    set((s) => ({
      mcpServers: s.mcpServers.some((m) => m.id === saved.id)
        ? s.mcpServers.map((m) => (m.id === saved.id ? saved : m))
        : [...s.mcpServers, saved],
    }));
  },

  async deleteMcpServer(id) {
    if (typeof window === "undefined" || !window.electron?.tools) return;
    const prev = get().mcpServers;
    set({ mcpServers: prev.filter((m) => m.id !== id) });
    try {
      await window.electron.tools.deleteMcpServer(id);
    } catch (err) {
      console.error("[tools] deleteMcpServer error", err);
      set({ mcpServers: prev }); // rollback so the UI stays consistent + retryable
    }
  },

  async fetchMcpTools(serverId) {
    if (typeof window === "undefined" || !window.electron?.tools?.listMcpTools) return;
    set((s) => ({
      mcpTools: { ...s.mcpTools, [serverId]: { loading: true, tools: s.mcpTools[serverId]?.tools ?? [] } },
    }));
    try {
      const res = await window.electron.tools.listMcpTools(serverId);
      set((s) => ({
        mcpTools: {
          ...s.mcpTools,
          [serverId]: res.ok
            ? { loading: false, tools: res.tools }
            : { loading: false, tools: [], error: res.error ?? "Failed to list tools" },
        },
      }));
    } catch (err) {
      set((s) => ({
        mcpTools: { ...s.mcpTools, [serverId]: { loading: false, tools: [], error: String(err) } },
      }));
    }
  },

  async setMcpToolEnabled(serverId, toolName, enabled) {
    if (typeof window === "undefined" || !window.electron?.tools) return;
    const server = get().mcpServers.find((m) => m.id === serverId);
    if (!server) return;
    // Derive from the latest in-memory disabledTools and update state
    // synchronously, so rapid successive toggles each see the freshest array
    // (rather than a snapshot captured before an in-flight save resolves).
    const current = new Set(server.disabledTools ?? []);
    if (enabled) current.delete(toolName);
    else current.add(toolName);
    const next: McpServerConfig = { ...server, disabledTools: [...current] };
    set((s) => ({ mcpServers: s.mcpServers.map((m) => (m.id === serverId ? next : m)) }));
    // Persist directly (not via saveMcpServer, whose resolve replaces the whole
    // record) so a slow/out-of-order response can't clobber a newer toggle.
    try {
      await window.electron.tools.saveMcpServer(next);
    } catch (err) {
      console.error("[tools] setMcpToolEnabled error", err);
      if (get().activeWorkspaceId) get().fetchTools(get().activeWorkspaceId!);
    }
  },

  async saveCustomService(service) {
    if (typeof window === "undefined" || !window.electron?.tools) return;
    const saved = await window.electron.tools.saveService(service) as CustomServiceConfig;
    set((s) => ({
      customServices: s.customServices.some((c) => c.id === saved.id)
        ? s.customServices.map((c) => (c.id === saved.id ? saved : c))
        : [...s.customServices, saved],
    }));
  },

  async deleteCustomService(id) {
    if (typeof window === "undefined" || !window.electron?.tools) return;
    const prev = get().customServices;
    set({ customServices: prev.filter((c) => c.id !== id) });
    try {
      await window.electron.tools.deleteService(id);
    } catch (err) {
      console.error("[tools] deleteCustomService error", err);
      set({ customServices: prev }); // rollback
    }
  },

  async fetchToolAttachments(projectId) {
    if (typeof window === "undefined" || !window.electron?.tools) return;
    try {
      const toolAttachments = await window.electron.tools.listAttachments(projectId) as ToolAttachment[];
      // Guard against a late response overwriting a newer active project.
      if (get().activeProjectId && get().activeProjectId !== projectId) return;
      set({ toolAttachments });
    } catch (err) {
      console.error("[tools] fetchToolAttachments error", err);
    }
  },

  async setToolAttachment(projectId, toolType, toolId, enabled) {
    if (typeof window === "undefined" || !window.electron?.tools) return;
    const next: ToolAttachment = { projectId, toolType, toolId, enabled };
    set((s) => ({
      toolAttachments: s.toolAttachments.some((a) => a.toolType === toolType && a.toolId === toolId && a.projectId === projectId)
        ? s.toolAttachments.map((a) => (a.toolType === toolType && a.toolId === toolId && a.projectId === projectId ? next : a))
        : [...s.toolAttachments, next],
    }));
    try {
      await window.electron.tools.setAttachment(next);
    } catch (err) {
      console.error("[tools] setToolAttachment error", err);
      get().fetchToolAttachments(projectId);
    }
  },

  async clearToolAttachment(projectId, toolType, toolId) {
    if (typeof window === "undefined" || !window.electron?.tools) return;
    set((s) => ({
      toolAttachments: s.toolAttachments.filter(
        (a) => !(a.toolType === toolType && a.toolId === toolId && a.projectId === projectId),
      ),
    }));
    try {
      await window.electron.tools.clearAttachment({ projectId, toolType, toolId });
    } catch (err) {
      console.error("[tools] clearToolAttachment error", err);
      get().fetchToolAttachments(projectId);
    }
  },
});
