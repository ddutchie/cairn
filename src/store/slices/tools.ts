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

export interface ToolsSlice {
  mcpServers: McpServerConfig[];
  customServices: CustomServiceConfig[];
  /** Attachments for the currently-loaded project (keyed by project on fetch). */
  toolAttachments: ToolAttachment[];

  fetchTools: (workspaceId: string) => Promise<void>;
  saveMcpServer: (server: Partial<McpServerConfig>) => Promise<void>;
  deleteMcpServer: (id: string) => Promise<void>;
  saveCustomService: (service: Partial<CustomServiceConfig>) => Promise<void>;
  deleteCustomService: (id: string) => Promise<void>;

  fetchToolAttachments: (projectId: string) => Promise<void>;
  setToolAttachment: (projectId: string, toolType: ToolType, toolId: string, enabled: boolean) => Promise<void>;
  clearToolAttachment: (projectId: string, toolType: ToolType, toolId: string) => Promise<void>;
}

export const createToolsSlice: StateCreator<CairnStore, [], [], ToolsSlice> = (set, get) => ({
  mcpServers: [],
  customServices: [],
  toolAttachments: [],

  async fetchTools(workspaceId) {
    if (typeof window === "undefined" || !window.electron) return;
    try {
      const [mcpServers, customServices] = await Promise.all([
        window.electron.tools.listMcpServers(workspaceId) as Promise<McpServerConfig[]>,
        window.electron.tools.listServices(workspaceId) as Promise<CustomServiceConfig[]>,
      ]);
      set({ mcpServers, customServices });
    } catch (err) {
      console.error("[tools] fetchTools error", err);
    }
  },

  async saveMcpServer(server) {
    if (typeof window === "undefined" || !window.electron) return;
    try {
      const saved = await window.electron.tools.saveMcpServer(server) as McpServerConfig;
      set((s) => ({
        mcpServers: s.mcpServers.some((m) => m.id === saved.id)
          ? s.mcpServers.map((m) => (m.id === saved.id ? saved : m))
          : [...s.mcpServers, saved],
      }));
    } catch (err) {
      console.error("[tools] saveMcpServer error", err);
    }
  },

  async deleteMcpServer(id) {
    if (typeof window === "undefined" || !window.electron) return;
    set((s) => ({ mcpServers: s.mcpServers.filter((m) => m.id !== id) }));
    try {
      await window.electron.tools.deleteMcpServer(id);
    } catch (err) {
      console.error("[tools] deleteMcpServer error", err);
    }
  },

  async saveCustomService(service) {
    if (typeof window === "undefined" || !window.electron) return;
    try {
      const saved = await window.electron.tools.saveService(service) as CustomServiceConfig;
      set((s) => ({
        customServices: s.customServices.some((c) => c.id === saved.id)
          ? s.customServices.map((c) => (c.id === saved.id ? saved : c))
          : [...s.customServices, saved],
      }));
    } catch (err) {
      console.error("[tools] saveCustomService error", err);
    }
  },

  async deleteCustomService(id) {
    if (typeof window === "undefined" || !window.electron) return;
    set((s) => ({ customServices: s.customServices.filter((c) => c.id !== id) }));
    try {
      await window.electron.tools.deleteService(id);
    } catch (err) {
      console.error("[tools] deleteCustomService error", err);
    }
  },

  async fetchToolAttachments(projectId) {
    if (typeof window === "undefined" || !window.electron) return;
    try {
      const toolAttachments = await window.electron.tools.listAttachments(projectId) as ToolAttachment[];
      set({ toolAttachments });
    } catch (err) {
      console.error("[tools] fetchToolAttachments error", err);
    }
  },

  async setToolAttachment(projectId, toolType, toolId, enabled) {
    if (typeof window === "undefined" || !window.electron) return;
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
    if (typeof window === "undefined" || !window.electron) return;
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
