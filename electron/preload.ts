/**
 * Cairn — Preload script
 *
 * Exposes a typed `window.electron` API to the renderer via contextBridge.
 * Only whitelisted channels are accessible — the renderer has no access
 * to Node.js or Electron internals directly.
 */

import { contextBridge, ipcRenderer } from "electron";

// Helper: invoke an IPC channel with typed args and return value
function invoke<T>(channel: string, args?: unknown): Promise<T> {
  return ipcRenderer.invoke(channel, args) as Promise<T>;
}

const api = {
  // ── Full snapshot ────────────────────────────
  snapshot: () => invoke("db:snapshot"),
  hasData:  () => invoke<boolean>("db:hasData"),

  // ── Workspaces ───────────────────────────────
  workspace: {
    list:   () => invoke("db:workspace:list"),
    create: (args: unknown) => invoke("db:workspace:create", args),
    update: (id: string, patch: unknown) => invoke("db:workspace:update", { id, patch }),
  },

  // ── Projects ─────────────────────────────────
  project: {
    list:   (workspaceId?: string) => invoke("db:project:list", { workspaceId }),
    create: (args: unknown) => invoke("db:project:create", args),
    update: (id: string, patch: unknown) => invoke("db:project:update", { id, patch }),
  },

  // ── Notes ────────────────────────────────────
  note: {
    list:   (projectId?: string) => invoke("db:note:list", { projectId }),
    create: (args: unknown) => invoke("db:note:create", args),
    update: (id: string, patch: unknown) => invoke("db:note:update", { id, patch }),
    delete: (id: string) => invoke("db:note:delete", { id }),
  },

  // ── Board columns ─────────────────────────────
  column: {
    list:   (projectId?: string) => invoke("db:column:list", { projectId }),
    create: (args: unknown) => invoke("db:column:create", args),
    update: (id: string, patch: unknown) => invoke("db:column:update", { id, patch }),
  },

  // ── Task cards ────────────────────────────────
  card: {
    list:   (opts?: unknown) => invoke("db:card:list", opts),
    create: (args: unknown) => invoke("db:card:create", args),
    update: (id: string, patch: unknown) => invoke("db:card:update", { id, patch }),
    delete: (id: string) => invoke("db:card:delete", { id }),
  },

  // ── Tags ─────────────────────────────────────
  tag: {
    list:   (workspaceId?: string) => invoke("db:tag:list", { workspaceId }),
    create: (args: unknown) => invoke("db:tag:create", args),
  },

  // ── Chat ─────────────────────────────────────
  chat: {
    threads:       (workspaceId: string) => invoke("db:chat:threads", { workspaceId }),
    messages:      (threadId: string) => invoke("db:chat:messages", { threadId }),
    upsertThread:  (args: unknown) => invoke("db:chat:upsertThread", args),
    addMessage:    (args: unknown) => invoke("db:chat:addMessage", args),
  },
  // ── AI Chat completions ────────────────────────
  chatSend: (req: unknown) => invoke<unknown>("chat:send", req),
  generatePrd: (args: unknown) => invoke<{ id: string; title: string; projectId: string } | { error: string }>("ai:generatePrd", args),

  // ── App paths ─────────────────────────────────
  mcpServerPath: () => invoke<string>("app:mcpServerPath"),

  // ── Workspace folder ──────────────────────────
  selectWorkspaceFolder: () => invoke<string | null>("app:selectWorkspaceFolder"),
  getWorkspacePath: () => invoke<string | null>("app:getWorkspacePath"),
  needsWorkspaceSetup: () => invoke<boolean>("app:needsWorkspaceSetup"),
  initWorkspace: (workspacePath: string) => invoke<{ requiresRestart: boolean }>("app:initWorkspace", { workspacePath }),

  // ── DB change notifications (from MCP writes) ─
  onDbChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("db:changed", handler);
    return () => ipcRenderer.off("db:changed", handler);
  },

  // ── Live tool call events during chat:send ────
  onToolCall: (cb: (e: { tool: string; label: string; args: Record<string, unknown> }) => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (_: any, e: { tool: string; label: string; args: Record<string, unknown> }) => cb(e);
    ipcRenderer.on("chat:tool-call", handler);
    return () => ipcRenderer.off("chat:tool-call", handler);
  },
} as const;

contextBridge.exposeInMainWorld("electron", api);

// ── Type export for the renderer ────────────────
// Import this type in the renderer to get full type safety on window.electron
export type ElectronAPI = typeof api;
