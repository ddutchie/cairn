/**
 * Cairn — Preload script
 *
 * Exposes a typed `window.electron` API to the renderer via contextBridge.
 * Only whitelisted channels are accessible — the renderer has no access
 * to Node.js or Electron internals directly.
 */

import { contextBridge, ipcRenderer } from "electron";

// Local structural types for the external-tools namespace. The renderer's
// canonical types live in src/types; electron's rootDir excludes src, so we
// mirror the shapes here (kept in sync by the IPC return types).
interface McpServerConfig {
  id: string; workspaceId: string; name: string; description?: string;
  transport: "sse" | "http"; baseUrl: string; headers?: Record<string, string>;
  authMode?: "none" | "oauth"; oauthScope?: string;
  enabled: boolean; source: string; communityId?: string; version?: string;
  disabledTools?: string[];
  createdAt: string; updatedAt: string;
}
interface CustomServiceConfig {
  id: string; workspaceId: string; name: string; description?: string;
  apiUrl: string; method: "GET" | "POST" | "PUT" | "DELETE"; headers?: Record<string, string>;
  toolDefinition: string; responseKeys?: string[]; apiKeyUrl?: string;
  authMode?: "none" | "oauth";
  oauth?: { serverUrl?: string; scope?: string; clientId?: string; authorizationUrl?: string; tokenUrl?: string };
  enabled: boolean; source: string; communityId?: string; version?: string;
  createdAt: string; updatedAt: string;
}
interface ToolAttachment {
  projectId: string; toolType: "mcp" | "service"; toolId: string; enabled: boolean;
}
// ── Community registry (cairn-community manifest) ───────────────────────────
interface RegistryEntryMeta {
  id: string; author: string; version: string; category?: string; tags: string[]; blurb: string;
  brandColor?: string; homepage?: string; iconSvg?: string;
}
interface RegistryMcpEntry extends RegistryEntryMeta {
  definition: {
    name: string; description?: string; transport: "sse" | "http"; baseUrl: string;
    headers?: Record<string, string>; authMode?: "none" | "oauth"; oauthScope?: string;
    disabledTools?: string[]; enabled: boolean;
  };
}
interface RegistryServiceEntry extends RegistryEntryMeta {
  definition: {
    name: string; description?: string; apiUrl: string;
    method: "GET" | "POST" | "PUT" | "DELETE"; headers?: Record<string, string>;
    toolDefinition: string; responseKeys?: string[]; apiKeyUrl?: string;
    authMode?: "none" | "oauth";
    oauth?: { serverUrl?: string; scope?: string; clientId?: string; authorizationUrl?: string; tokenUrl?: string };
    enabled: boolean;
  };
}
interface RegistryCommandEntry extends RegistryEntryMeta {
  definition: {
    name: string; description?: string; insertText: string; scope: "chat" | "agent" | "both";
  };
}
interface CommunityManifest {
  version: number; updatedAt: string;
  mcpServers: RegistryMcpEntry[]; services: RegistryServiceEntry[]; commands: RegistryCommandEntry[];
}
interface RegistryFetchResult {
  manifest: CommunityManifest; fromCache: boolean; cachedAt?: string; error?: string;
}
// ── Inline types for the codebase index / Architecture tab ──────────────────
interface CodebaseSymbol {
  id: string; file_id: string; name: string; kind: string; line: number;
  signature: string; docstring: string | null; file_path: string; root_path: string;
}
interface CodebaseOverviewFile {
  id: string; file_path: string; root_path: string; indexed_at: string;
  symbol_count: number; relation_count: number;
}
interface CodebaseOverview {
  folder: string; roots: string[]; fileCount: number; totalSymbols: number;
  totalRelations: number; lastIndexedAt: string | null;
  kinds: { kind: string; count: number }[];
  files: CodebaseOverviewFile[];
}
interface CodebaseRelationEdge {
  type: string; target_name: string; source_name: string; source_file: string;
}
interface CodebaseRelations {
  incoming: CodebaseRelationEdge[]; outgoing: CodebaseRelationEdge[];
}
interface CodebaseGraphNode {
  id: string; file_path: string; root_path: string; symbol_count: number;
}
interface CodebaseGraphEdge {
  source: string; target: string; weight: number;
}
interface CodebaseGraph {
  folder: string; nodes: CodebaseGraphNode[]; edges: CodebaseGraphEdge[];
}
interface CodebaseModuleNode {
  id: string; label: string; fileCount: number; symbolCount: number; internalRefs: number;
}
interface CodebaseModuleGraph {
  folder: string; depth: number; grouping: "directory";
  nodes: CodebaseModuleNode[];
  edges: CodebaseGraphEdge[];
}
// ── Inline types for the git API (not shared with the renderer bundle) ──────

interface GitStatusEntry {
  path: string;
  status: string;
}

interface GitStatus {
  branch: string;
  ahead: string;
  behind: string;
  hasUpstream: boolean;
  defaultBranch: string;
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: GitStatusEntry[];
}

// Helper: invoke an IPC channel and unwrap the IpcResult<T> wrapper.
// All handlers return { data: T } | { error: string } via the handle() helper.
// We unwrap here so callers receive T directly (or a rejected promise on error).
function invoke<T>(channel: string, args?: unknown): Promise<T> {
  return ipcRenderer.invoke(channel, args).then((result: { data: T } | { error: string }) => {
    if (result && typeof result === "object" && "error" in result) {
      throw new Error((result as { error: string }).error);
    }
    return (result as { data: T }).data;
  });
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
    updateSettings: (id: string, settings: unknown) => invoke("db:project:updateSettings", { id, settings }),
    delete: (id: string) => invoke("db:project:delete", { id }),
    merge:  (sourceId: string, targetId: string) => invoke("db:project:merge", { sourceId, targetId }),
  },

  // ── Notes ────────────────────────────────────
  note: {
    list:         (projectId?: string) => invoke("db:note:list", { projectId }),
    create:       (args: unknown) => invoke("db:note:create", args),
    update:       (id: string, patch: unknown) => invoke("db:note:update", { id, patch }),
    delete:       (id: string) => invoke("db:note:delete", { id }),
    moveToFolder: (id: string, folder: string) => invoke("db:note:moveToFolder", { id, folder }),
    // workspaceId is derived from the target project by the handler; accepted for
    // backwards-compatible call sites but no longer required.
    moveToProject: (id: string, projectId: string, _workspaceId?: string) =>
      invoke("db:note:moveToProject", { id, projectId }),
  },

  // ── Board columns ─────────────────────────────
  column: {
    list:   (projectId?: string) => invoke("db:column:list", { projectId }),
    create: (args: unknown) => invoke("db:column:create", args),
    update: (id: string, patch: unknown) => invoke("db:column:update", { id, patch }),
    delete: (id: string) => invoke("db:column:delete", { id }),
  },

  // ── Task cards ────────────────────────────────
  card: {
    list:         (opts?: unknown) => invoke("db:card:list", opts),
    create:       (args: unknown) => invoke("db:card:create", args),
    update:       (id: string, patch: unknown) => invoke("db:card:update", { id, patch }),
    moveToProject:(id: string, projectId: string, columnId: string, order: number) =>
      invoke("db:card:moveToProject", { id, projectId, columnId, order }),
    delete:       (id: string) => invoke("db:card:delete", { id }),
    archiveDone:  (columnId: string) => invoke("db:cards:archive-done", { columnId }),
    addBlocker:   (cardId: string, blockerCardId: string) => invoke("db:card:addBlocker", { cardId, blockerCardId }),
    removeBlocker:(cardId: string, blockerCardId: string) => invoke("db:card:removeBlocker", { cardId, blockerCardId }),
    ready:        (projectId?: string) => invoke("db:card:ready", { projectId }),
  },

  // ── Idea Flow ────────────────────────────────
  flow: {
    get:         (projectId: string) => invoke("db:flow:get", { projectId }),
    node: {
      create:    (args: unknown) => invoke("db:flow:node:create", args),
      update:    (id: string, patch: unknown) => invoke("db:flow:node:update", { id, patch }),
      delete:    (id: string) => invoke("db:flow:node:delete", { id }),
      summarize: (nodeId: string, config: unknown) => invoke("db:flow:node:summarize", { nodeId, config }),
    },
    edge: {
      create: (args: unknown) => invoke("db:flow:edge:create", args),
      delete: (id: string) => invoke("db:flow:edge:delete", { id }),
    },
    url: {
      fetch: (url: string) => invoke<{ title: string; description: string }>("db:flow:url:fetch", { url }),
    },
  },

  // ── Tags ─────────────────────────────────────
  tag: {
    list:   (workspaceId?: string) => invoke("db:tag:list", { workspaceId }),
    create: (args: unknown) => invoke("db:tag:create", args),
    update: (id: string, patch: unknown) => invoke("db:tag:update", { id, patch }),
    delete: (id: string) => invoke("db:tag:delete", { id }),
  },

  // ── Slash commands ───────────────────────────
  command: {
    list:   (workspaceId?: string) => invoke("db:command:list", { workspaceId }),
    create: (args: unknown) => invoke("db:command:create", args),
    update: (id: string, patch: unknown) => invoke("db:command:update", { id, patch }),
    delete: (id: string) => invoke("db:command:delete", { id }),
  },

  // ── Chat ─────────────────────────────────────
  chat: {
    threads:       (workspaceId: string) => invoke("db:chat:threads", { workspaceId }),
    messages:      (threadId: string) => invoke("db:chat:messages", { threadId }),
    upsertThread:  (args: unknown) => invoke("db:chat:upsertThread", args),
    addMessage:    (args: unknown) => invoke("db:chat:addMessage", args),
    deleteThread:  (threadId: string) => invoke("db:chat:deleteThread", { threadId }),
    clearThreadMessages: (threadId: string) => invoke("db:chat:clearThreadMessages", { threadId }),
    compactThread: (req: unknown) => invoke("chat:compactThread", req),
    // ── AI Chat streaming ──────────────────────
    // Fire-and-forget. Listen with onToken / onDone / onToolCall.
    stream: (req: unknown) => ipcRenderer.send("chat:stream", req),
    abort: () => ipcRenderer.send("chat:abort"),
    onToken: (cb: (e: { delta: string; threadId?: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { delta: string; threadId?: string }) => cb(e);
      ipcRenderer.on("chat:token", handler);
      return () => ipcRenderer.off("chat:token", handler);
    },
    onThought: (cb: (e: { delta: string; threadId?: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { delta: string; threadId?: string }) => cb(e);
      ipcRenderer.on("chat:thought", handler);
      return () => ipcRenderer.off("chat:thought", handler);
    },
    onDone: (cb: (e: { content: string; reasoning?: string; contextRefs: unknown[]; error?: string; threadId?: string; usage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number; breakdown?: unknown } }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { content: string; reasoning?: string; contextRefs: unknown[]; error?: string; threadId?: string }) => cb(e);
      ipcRenderer.on("chat:done", handler);
      return () => ipcRenderer.off("chat:done", handler);
    },
    onToolCall: (cb: (e: { tool: string; label: string; args: Record<string, unknown>; callId?: string; threadId?: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { tool: string; label: string; args: Record<string, unknown>; callId?: string; threadId?: string }) => cb(e);
      ipcRenderer.on("chat:tool-call", handler);
      return () => ipcRenderer.off("chat:tool-call", handler);
    },
    onToolCallDone: (cb: (e: { tool: string; cairnRef?: { type: "note" | "task"; id: string; title: string }; externalRef?: { url: string; title?: string; snippet?: string }; output?: string; callId?: string; threadId?: string; ok?: boolean; error?: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { tool: string; cairnRef?: { type: "note" | "task"; id: string; title: string }; externalRef?: { url: string; title?: string; snippet?: string }; output?: string; callId?: string; threadId?: string; ok?: boolean; error?: string }) => cb(e);
      ipcRenderer.on("chat:tool-call-done", handler);
      return () => ipcRenderer.off("chat:tool-call-done", handler);
    },
    onUsage: (cb: (e: { promptTokens: number; completionTokens: number; reasoningTokens?: number; breakdown?: unknown; threadId?: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { promptTokens: number; completionTokens: number; reasoningTokens?: number; breakdown?: unknown; threadId?: string }) => cb(e);
      ipcRenderer.on("chat:usage", handler);
      return () => ipcRenderer.off("chat:usage", handler);
    },
    // ── Subagent mode (dispatch → research/write) live trace ────────────────
    onSubagent: (cb: (e: { childId: string; role: string; instruction?: string; result?: string; status: "start" | "done"; threadId?: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: any) => cb(e);
      ipcRenderer.on("chat:subagent", handler);
      return () => ipcRenderer.off("chat:subagent", handler);
    },
    onSubagentToken: (cb: (e: { childId: string; delta: string; threadId?: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: any) => cb(e);
      ipcRenderer.on("chat:subagent-token", handler);
      return () => ipcRenderer.off("chat:subagent-token", handler);
    },
    onSubagentThought: (cb: (e: { childId: string; delta: string; threadId?: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: any) => cb(e);
      ipcRenderer.on("chat:subagent-thought", handler);
      return () => ipcRenderer.off("chat:subagent-thought", handler);
    },
    onSubagentToolCall: (cb: (e: { childId: string; tool: string; label: string; args: Record<string, unknown>; callId?: string; threadId?: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: any) => cb(e);
      ipcRenderer.on("chat:subagent-tool-call", handler);
      return () => ipcRenderer.off("chat:subagent-tool-call", handler);
    },
    onSubagentToolCallDone: (cb: (e: { childId: string; tool: string; cairnRef?: { type: "note" | "task"; id: string; title: string }; externalRef?: { url: string; title?: string; snippet?: string }; output?: string; callId?: string; threadId?: string; ok?: boolean; error?: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: any) => cb(e);
      ipcRenderer.on("chat:subagent-tool-call-done", handler);
      return () => ipcRenderer.off("chat:subagent-tool-call-done", handler);
    },
    onSubagentUsage: (cb: (e: { childId: string; promptTokens: number; completionTokens: number; reasoningTokens?: number; threadId?: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: any) => cb(e);
      ipcRenderer.on("chat:subagent-usage", handler);
      return () => ipcRenderer.off("chat:subagent-usage", handler);
    },
    // ── Pop-out window ──────────────────────────
    /** Called by main window: sends current chat state, triggers window creation. */
    popOut: (payload: {
      threadId: string | null;
      chatThreads: unknown[];
      chatMessages: unknown[];
      activeProjectId: string | null;
    }) => invoke<{ ok: boolean }>("chat:popOut", payload),
    /** Called by pop-out page: signals readiness, returns stored chat state. */
    popoutReady: () => invoke<{
      threadId: string | null;
      chatThreads: unknown[];
      chatMessages: unknown[];
      activeProjectId: string | null;
    }>("chat:popoutReady"),
    /** Called by pop-out page: sends final state back, closes window. */
    popIn: (payload: {
      threadId: string | null;
      chatThreads: unknown[];
      chatMessages: unknown[];
      activeProjectId: string | null;
    }) => invoke<{ ok: boolean }>("chat:popIn", payload),
    /** Called by main window: asks the pop-out to return (relayed via main process). */
    requestPopIn: () => invoke<{ ok: boolean }>("chat:requestPopIn"),
    /** Listener on the main window: received when pop-in completes with final state. */
    onChatPoppedIn: (cb: (payload: {
      threadId: string | null;
      chatThreads: unknown[];
      chatMessages: unknown[];
      activeProjectId: string | null;
    }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, payload: any) => cb(payload);
      ipcRenderer.on("chat:poppedIn", handler);
      return () => ipcRenderer.off("chat:poppedIn", handler);
    },
    /** Listener on the main window: pop-out closed unexpectedly (e.g. Cmd+W). */
    onChatPoppedOutClosed: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on("chat:poppedOutClosed", handler);
      return () => ipcRenderer.off("chat:poppedOutClosed", handler);
    },
    /** Listener on the pop-out page: received when main window requests pop-in. */
    onChatRequestPopIn: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on("chat:requestPopIn", handler);
      return () => ipcRenderer.off("chat:requestPopIn", handler);
    },
  },

  // ── Knowledge Graph ───────────────────────────
  graph: {
    get:       (workspaceId: string, filters?: unknown) => invoke("db:graph:get", { workspaceId, filters }),
    neighbors: (workspaceId: string, nodeId: string, depth?: number, edgeTypes?: string[]) =>
                 invoke("db:graph:neighbors", { workspaceId, nodeId, depth, edgeTypes }),
    recompute: (workspaceId: string, entityIds?: string[]) => invoke("db:graph:recompute", { workspaceId, entityIds }),
  },

  // ── AI helpers ────────────────────────────────
  ai: {
    generatePrd: (args: unknown) => invoke<{ id: string; title: string; projectId: string }>("ai:generatePrd", args),
    generateCommitMessage: (args: { diff: string; config: { baseUrl: string; model: string; apiKey: string } }) =>
      invoke<{ subject: string; body: string }>("ai:generateCommitMessage", args),
    generatePrDescription: (args: { diff: string; config: { baseUrl: string; model: string; apiKey: string }; template?: string }) =>
      invoke<{ title: string; description: string }>("ai:generatePrDescription", args),
    explainArchitecture: (args: { summary: string; config: { baseUrl: string; model: string; apiKey: string } }) =>
      invoke<{ overview: string; modules: string }>("ai:explainArchitecture", args),
    localLLMStatus: () => invoke<{ available: boolean; reason?: string }>("ai:localLLMStatus"),
    fetchModels: (args: { baseUrl?: string; apiKey?: string }) =>
      invoke<string[]>("ai:fetchModels", args),
    fetchKeyInfo: (args: { baseUrl?: string; apiKey?: string }) =>
      invoke<{
        remaining: number | null;
        usage: number | null;
        limit: number | null;
        isFreeTier: boolean | null;
        currency: "USD";
      } | null>("ai:fetchKeyInfo", args),
  },

  // ── App paths ─────────────────────────────────
  mcpServerPath: () => invoke<string>("app:mcpServerPath"),
  latestChangelog: () => invoke<string | null>("app:latestChangelog"),

  // ── Reveal note in Finder / Explorer ─────────
  revealNote: (noteId: string, projectId: string) => invoke("app:revealNote", { noteId, projectId }),

  // ── Export note as PDF ────────────────────────
  exportNotePdf: (title: string, html: string, options?: { returnBuffer?: boolean; theme?: "light" | "dark" }) =>
    invoke<{ filePath?: string; pdfBase64?: string } | null>("app:exportNotePdf", { title, html, options }),

  // ── Export note / project as Markdown ─────────
  exportMarkdown: (kind: "note" | "project", id: string, options?: { returnText?: boolean }) =>
    invoke<{ filePath?: string; markdown?: string; title?: string } | null>(
      "app:exportMarkdown", { kind, id, returnText: options?.returnText },
    ),

  // ── Open a URL in the system default browser ──
  openExternal: (url: string) => ipcRenderer.send("app:openExternal", url),

  // ── Asset upload (pasted images) ──────────────
  // data is an ArrayBuffer — Electron's structured-clone transfers it
  // natively without serialising to a JSON number array.
  uploadAsset: (filename: string, data: ArrayBuffer) =>
    invoke<{ assetUrl: string }>("app:uploadAsset", { filename, data }),
  revealAssets: () => invoke("app:revealAssets"),

  // ── Workspace folder ──────────────────────────
  selectWorkspaceFolder: () => invoke<string | null>("app:selectWorkspaceFolder"),
  getWorkspacePath: () => invoke<string | null>("app:getWorkspacePath"),
  needsWorkspaceSetup: () => invoke<boolean>("app:needsWorkspaceSetup"),
  setTheme: (theme: string) => invoke("app:setTheme", theme),
  setAccent: (accent: string) => invoke("app:setAccent", accent),
  initWorkspace: (workspacePath: string) => invoke<{ requiresRestart: boolean }>("app:initWorkspace", { workspacePath }),
  rescanWorkspace: (workspaceId?: string) => invoke<{ projectsCreated: number; createdProjects: { id: string; name: string; noteCount: number }[] }>("app:rescanWorkspace", { workspaceId }),
  probeWorkspaceFolder: (folder: string) => invoke<{ isObsidianVault: boolean; markdownCount: number; folderCount: number }>("app:probeWorkspaceFolder", { folder }),
  relaunch: () => invoke("app:relaunch"),
  resetAllData: () => invoke("app:reset"),
  getAiSettings: () => invoke<Record<string, unknown> | null>("app:getAiSettings"),
  saveAiSettings: (config: Record<string, unknown>) => invoke<{ ok: true }>("app:saveAiSettings", { config }),
  getAgentSettings: () => invoke<Record<string, unknown> | null>("app:getAgentSettings"),
  saveAgentSettings: (config: Record<string, unknown>) => invoke<{ ok: true }>("app:saveAgentSettings", { config }),
  getTheme: () => invoke<string | null>("app:getTheme"),
  saveTheme: (theme: string) => invoke<{ ok: true }>("app:saveTheme", { theme }),
  getFontScale: () => invoke<number | null>("app:getFontScale"),
  saveFontScale: (fontScale: number) => invoke<{ ok: true }>("app:saveFontScale", { fontScale }),
  platform: process.platform as "darwin" | "win32" | "linux",

  // ── Migrations ────────────────────────────────
  checkMigrations: () => invoke<Array<{ id: string; title: string; description: string; needed: boolean }>>("app:checkMigrations"),
  runMigration: (migrationId: string) => invoke<{ ok: true }>("app:runMigration", { migrationId }),
  onMigrationProgress: (cb: (e: { migrationId: string; pct: number; msg: string }) => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (_: any, e: { migrationId: string; pct: number; msg: string }) => cb(e);
    ipcRenderer.on("app:migrationProgress", handler);
    return () => ipcRenderer.off("app:migrationProgress", handler);
  },

  // ── Auto-updater ──────────────────────────────
  updater: {
    onUpdateAvailable: (cb: (info: { version: string; releaseNotes: string | null }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, info: { version: string; releaseNotes: string | null }) => cb(info);
      ipcRenderer.on("updater:update-available", handler);
      return () => ipcRenderer.off("updater:update-available", handler);
    },
    onUpdateDownloaded: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on("updater:update-downloaded", handler);
      return () => ipcRenderer.off("updater:update-downloaded", handler);
    },
    install: () => ipcRenderer.invoke("updater:install"),
  },

  // ── DB change notifications (from MCP writes) ─
  onDbChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("db:changed", handler);
    return () => ipcRenderer.off("db:changed", handler);
  },

  // ── Desktop sync (synced-folder oplog: connect folder + manual sync) ──
  sync: {
    getFolder: () => invoke<string | null>("sync:getFolder"),
    selectFolder: () => invoke<string | null>("sync:selectFolder"),
    clearFolder: () => invoke<{ ok: true }>("sync:clearFolder"),
    now: () =>
      invoke<{
        drained: number;
        seeded: number;
        peerOpsApplied: number;
        peerOpsRead: number;
        conflictCopies: number;
        connected: boolean;
      }>("sync:now"),
    // Current live status snapshot (state + pending/conflict counts + lastSyncAt).
    status: () =>
      invoke<{
        state: "disabled" | "idle" | "syncing" | "offline";
        pending: number;
        conflicts: number;
        lastSyncAt: string | null;
        connected: boolean;
      }>("sync:status"),
    // Diagnostic: what's staged in sync_pending (entity/op/count + sample ids).
    pendingBreakdown: () =>
      invoke<{
        total: number;
        groups: { entity: string; op: string; count: number }[];
        sampleIds: Record<string, string[]>;
      }>("sync:pendingBreakdown"),
    // Subscribe to pushed status transitions. Returns an unsubscribe fn.
    onStatus: (cb: (status: {
      state: "disabled" | "idle" | "syncing" | "offline";
      pending: number;
      conflicts: number;
      lastSyncAt: string | null;
      connected: boolean;
    }) => void) => {
      const handler = (_e: unknown, status: {
        state: "disabled" | "idle" | "syncing" | "offline";
        pending: number;
        conflicts: number;
        lastSyncAt: string | null;
        connected: boolean;
      }) => cb(status);
      ipcRenderer.on("sync:status", handler as (event: unknown, ...args: unknown[]) => void);
      return () => ipcRenderer.off("sync:status", handler as (event: unknown, ...args: unknown[]) => void);
    },
    // Conflict copies awaiting manual resolution.
    listConflicts: () =>
      invoke<Array<{
        id: string;
        title: string;
        content: string | null;
        projectId: string;
        folder: string;
        updatedAt: string;
        deviceId: string | null;
        originalId: string | null;
        original: { id: string; title: string; content: string | null; updatedAt: string } | null;
        baseBody: string | null;
      }>>("sync:listConflicts"),
    resolveConflict: (
      copyId: string,
      action: "keepCopy" | "keepOriginal" | "keepMerged",
      mergedContent?: string,
    ) => invoke<{ resolvedOriginalId: string | null }>("sync:resolveConflict", { copyId, action, mergedContent }),
  },

  // ── AI write lock events ──────────────────────
  // Fired by the main process when the in-app AI chat executor starts or
  // finishes writing to a note. The renderer uses these to show a read-only
  // indicator on the active note editor.
  onAiWriteStarted: (cb: (payload: { noteId: string }) => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (_: any, payload: { noteId: string }) => cb(payload);
    ipcRenderer.on("note:aiWriteStarted", handler);
    return () => ipcRenderer.off("note:aiWriteStarted", handler);
  },
  onAiWriteEnded: (cb: (payload: { noteId: string }) => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (_: any, payload: { noteId: string }) => cb(payload);
    ipcRenderer.on("note:aiWriteEnded", handler);
    return () => ipcRenderer.off("note:aiWriteEnded", handler);
  },

  // ── Dashboard live query bridge ───────────────
  mcpQuery: (tool: string, args: Record<string, unknown>) => invoke<unknown>("db:mcpQuery", { tool, args }),

  // ── MCP notification badge ─────────────────────
  onMcpUnreadCount: (cb: (count: number) => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (_: any, count: number) => cb(count);
    ipcRenderer.on("mcp:unread-count", handler);
    return () => ipcRenderer.off("mcp:unread-count", handler);
  },
  markMcpNotificationsRead: () => ipcRenderer.invoke("mcp:markNotificationsRead"),

  // ── Agent / coding sessions ───────────────────
  // All methods go through invoke() so callers receive T directly and errors
  // are thrown (matching every other namespace in this file).
  agent: {
    getCodingAgents: () => invoke("agent:getCodingAgents"),
    saveCodingAgent: (agent: unknown) => invoke("agent:saveCodingAgent", agent),
    deleteCodingAgent: (id: string) => invoke("agent:deleteCodingAgent", { id }),
    setDefaultAgent: (id: string) => invoke("agent:setDefaultAgent", { id }),

    readDir: (dirPath: string) => invoke("agent:readDir", { dirPath }),
    searchFiles: (dirPath: string, query: string) => invoke<{ name: string; path: string; relativePath: string }[]>("agent:searchFiles", { dirPath, query }),
    readFile: (filePath: string) => invoke<string>("agent:readFile", { filePath }),
    readFileBase64: (filePath: string) => invoke<string>("agent:readFileBase64", { filePath }),
    writeFile: (filePath: string, content: string) =>
      invoke("agent:writeFile", { filePath, content }),
    validateDirectory: (dirPath: string) =>
      invoke<boolean>("agent:validateDirectory", { dirPath }),
    gitDiff: (cwd: string) => invoke<string>("agent:gitDiff", { cwd }),
    // Codebase index (Architecture tab) — read-only views over the semantic index.
    codebaseOverview: (folder: string) => invoke<CodebaseOverview>("agent:codebaseOverview", { folder }),
    codebaseGraph: (folder: string) => invoke<CodebaseGraph>("agent:codebaseGraph", { folder }),
    codebaseModuleGraph: (folder: string, depth?: number) =>
      invoke<CodebaseModuleGraph>("agent:codebaseModuleGraph", { folder, depth }),
    codebaseFileSymbols: (filePath: string) =>
      invoke<CodebaseSymbol[]>("agent:codebaseFileSymbols", { filePath }),
    codebaseRelations: (name: string, folder?: string) =>
      invoke<CodebaseRelations>("agent:codebaseRelations", { name, folder }),
    codebaseReindex: (folder: string) => invoke<CodebaseOverview>("agent:codebaseReindex", { folder }),
    codebaseReindexFile: (folder: string, filePath: string) =>
      invoke<boolean>("agent:codebaseReindexFile", { folder, filePath }),
    // Pickers bypass invoke() — they return { data: T } directly from the handler
    // and are not wrapped via handle(), so we keep them as raw invokes.
    pickDirectory: () => ipcRenderer.invoke("agent:pickDirectory"),
    pickFile: () => ipcRenderer.invoke("agent:pickFile"),

    spawn:      (payload: unknown) => invoke<{ sessionId: string }>("agent:spawn",      payload),
    spawnShell: (cwd: string)      => invoke<{ sessionId: string }>("agent:spawnShell", { cwd }),
    input: (sessionId: string, data: string) =>
      invoke("agent:input", { sessionId, data }),
    resize: (sessionId: string, cols: number, rows: number) =>
      invoke("agent:resize", { sessionId, cols, rows }),
    kill: (sessionId: string) => invoke("agent:kill", { sessionId }),

    onData: (cb: (payload: { sessionId: string; data: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, payload: { sessionId: string; data: string }) => cb(payload);
      ipcRenderer.on("agent:data", handler);
      return () => ipcRenderer.off("agent:data", handler);
    },

    onExit: (cb: (payload: { sessionId: string; exitCode: number }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, payload: { sessionId: string; exitCode: number }) => cb(payload);
      ipcRenderer.on("agent:exit", handler);
      return () => ipcRenderer.off("agent:exit", handler);
    },
  },

  // ── External tools (MCP servers + custom HTTP services) ───────
  tools: {
    listMcpServers: (workspaceId: string) =>
      invoke<McpServerConfig[]>("tools:listMcpServers", { workspaceId }),
    saveMcpServer: (server: Partial<McpServerConfig>) =>
      invoke<McpServerConfig>("tools:saveMcpServer", server),
    deleteMcpServer: (id: string) => invoke("tools:deleteMcpServer", { id }),
    testMcp: (id: string) =>
      invoke<{ ok: boolean; toolCount?: number; toolNames?: string[]; error?: string }>(
        "tools:testMcp",
        { id }
      ),
    listMcpTools: (id: string) =>
      invoke<{ ok: boolean; tools: Array<{ name: string; description?: string }>; error?: string }>(
        "tools:listMcpTools",
        { id }
      ),

    listServices: (workspaceId: string) =>
      invoke<CustomServiceConfig[]>("tools:listServices", { workspaceId }),
    saveService: (service: Partial<CustomServiceConfig>) =>
      invoke<CustomServiceConfig>("tools:saveService", service),
    deleteService: (id: string) => invoke("tools:deleteService", { id }),
    testService: (id: string, sampleArgs?: Record<string, unknown>) =>
      invoke<{ ok: boolean; status?: number; preview?: string; error?: string }>(
        "tools:testService",
        { id, sampleArgs }
      ),

    listAttachments: (projectId: string) =>
      invoke<ToolAttachment[]>("tools:listAttachments", { projectId }),
    setAttachment: (a: ToolAttachment) => invoke<ToolAttachment>("tools:setAttachment", a),
    clearAttachment: (a: Omit<ToolAttachment, "enabled">) => invoke("tools:clearAttachment", a),

    // OAuth (remote MCP servers gated behind an authorization page).
    startMcpAuth: (id: string) =>
      invoke<{ status: "redirected" | "already_authorized" | "error"; error?: string }>(
        "tools:startMcpAuth",
        { id }
      ),
    mcpAuthStatus: (id: string) => invoke<{ connected: boolean }>("tools:mcpAuthStatus", { id }),
    signOutMcp: (id: string) => invoke("tools:signOutMcp", { id }),
    /** Cancel an in-flight OAuth sign-in (user abandoned the browser step). */
    cancelMcpAuth: (id: string) => invoke<{ cancelled: boolean }>("tools:cancelMcpAuth", { id }),

    // OAuth for custom HTTP services (same flow as MCP, no transport).
    startServiceAuth: (id: string) =>
      invoke<{ status: "redirected" | "already_authorized" | "error"; error?: string }>(
        "tools:startServiceAuth",
        { id }
      ),
    serviceAuthStatus: (id: string) =>
      invoke<{ connected: boolean }>("tools:serviceAuthStatus", { id }),
    signOutService: (id: string) => invoke("tools:signOutService", { id }),
    cancelServiceAuth: (id: string) =>
      invoke<{ cancelled: boolean }>("tools:cancelServiceAuth", { id }),
    /** Fires when a cairn://oauth/callback deep link finishes a sign-in. */
    onOauthCallback: (
      cb: (e: { status: string; serverId?: string; error?: string }) => void
    ) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { status: string; serverId?: string; error?: string }) => cb(e);
      ipcRenderer.on("tools:oauthCallback", handler);
      return () => ipcRenderer.off("tools:oauthCallback", handler);
    },
  },

  // ── Secrets (OS keychain). No get() by design — renderer only learns set/not-set.
  secrets: {
    available: () => invoke<boolean>("secrets:available"),
    set: (toolType: "mcp" | "service" | "llm", toolId: string, key: string, value: string) =>
      invoke<string>("secrets:set", { toolType, toolId, key, value }),
    has: (toolType: "mcp" | "service" | "llm", toolId: string, key: string) =>
      invoke<boolean>("secrets:has", { toolType, toolId, key }),
    delete: (toolType: "mcp" | "service" | "llm", toolId: string, key: string) =>
      invoke("secrets:delete", { toolType, toolId, key }),
  },

  // ── Community registry (cairn-community catalog) ──────────────
  registry: {
    /** Cache-first: instant/offline, background-revalidates. */
    fetch: () => invoke<RegistryFetchResult>("registry:fetch"),
    /** Force a network refresh (explicit Refresh button). */
    refresh: () => invoke<RegistryFetchResult>("registry:refresh"),
  },

  // ── Git operations (Agent Git tab) ────────────
  git: {
    status:   (cwd: string) => invoke<GitStatus>("git:status", { cwd }),
    branches: (cwd: string) => invoke<{ current: string; branches: Array<{ name: string; current: boolean }> }>("git:branches", { cwd }),
    checkout: (cwd: string, branch: string, create?: boolean) => invoke<{ branch: string }>("git:checkout", { cwd, branch, create }),
    stage:    (cwd: string, opts?: { files?: string[]; all?: boolean }) => invoke<{ ok: boolean }>("git:stage", { cwd, ...opts }),
    unstage:  (cwd: string, opts?: { files?: string[]; all?: boolean }) => invoke<{ ok: boolean }>("git:unstage", { cwd, ...opts }),
    commit:   (cwd: string, message: string, body?: string, autoStage?: boolean) => invoke<{ hash: string; message: string }>("git:commit", { cwd, message, body, autoStage }),
    push:     (cwd: string, setUpstream?: boolean) => invoke<{ branch: string }>("git:push", { cwd, setUpstream }),
    log:      (cwd: string, count?: number) => invoke<Array<{ hash: string; author: string; date: string; subject: string }>>("git:log", { cwd, count }),
    diff:     (cwd: string, staged?: boolean) => invoke<string>("git:diff", { cwd, staged }),
    diffBranch: (cwd: string, baseBranch: string) => invoke<string>("git:diffBranch", { cwd, baseBranch }),
    diffFile: (cwd: string, filePath: string, staged?: boolean) => invoke<{ stat: { added: number; deleted: number }; diff: string }>("git:diffFile", { cwd, filePath, staged }),
    stash:    (cwd: string, action: "push" | "pop" | "list") => invoke<unknown>("git:stash", { cwd, action }),
    createPr: (cwd: string, opts: { title: string; body?: string; base?: string }) => invoke<{ url: string; branch: string }>("git:createPr", { cwd, ...opts }),
    prStatus: (cwd: string) => invoke<{ url: string | null; state: string | null; title: string | null } | null>("git:prStatus", { cwd }),
    discard:  (cwd: string, filePath: string) => invoke<{ ok: boolean }>("git:discard", { cwd, filePath }),
  },

  // ── Cairn native agent (pi) ───────────────────
  piAgent: {
    /** Send a prompt to an existing or new session. Fire-and-forget. */
    prompt: (req: unknown) => ipcRenderer.send("pi-agent:prompt", req),
    /** Abort the current in-flight turn for this session. */
    abort: (sessionId: string) => ipcRenderer.send("pi-agent:abort", { sessionId }),
    /** Clear message history for a session (start fresh). */
    clear: (sessionId: string) => ipcRenderer.send("pi-agent:clear", { sessionId }),
    /** Destroy a session when the tab is closed. */
    destroy: (sessionId: string) => ipcRenderer.send("pi-agent:destroy", { sessionId }),
    /** Trigger immediate LLM-based compaction on demand (/compact command). */
    compactNow: (req: unknown) => ipcRenderer.send("pi-agent:compact-now", req),

    onToken: (cb: (e: { sessionId: string; delta: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; delta: string }) => cb(e);
      ipcRenderer.on("pi-agent:token", handler);
      return () => ipcRenderer.off("pi-agent:token", handler);
    },
    onThought: (cb: (e: { sessionId: string; delta: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; delta: string }) => cb(e);
      ipcRenderer.on("pi-agent:thought", handler);
      return () => ipcRenderer.off("pi-agent:thought", handler);
    },
    onTool: (cb: (e: { sessionId: string; name: string; label: string; callId?: string; status: "pending" | "start" | "end"; ok?: boolean; output?: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; name: string; label: string; callId?: string; status: "pending" | "start" | "end"; ok?: boolean; output?: string }) => cb(e);
      ipcRenderer.on("pi-agent:tool", handler);
      return () => ipcRenderer.off("pi-agent:tool", handler);
    },
    onDone: (cb: (e: { sessionId: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string }) => cb(e);
      ipcRenderer.on("pi-agent:done", handler);
      return () => ipcRenderer.off("pi-agent:done", handler);
    },
    onError: (cb: (e: { sessionId: string; error: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; error: string }) => cb(e);
      ipcRenderer.on("pi-agent:error", handler);
      return () => ipcRenderer.off("pi-agent:error", handler);
    },
    onToolsReady: (cb: (e: { sessionId: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string }) => cb(e);
      ipcRenderer.on("pi-agent:tools-ready", handler);
      return () => ipcRenderer.off("pi-agent:tools-ready", handler);
    },
    onStep: (cb: (e: { sessionId: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string }) => cb(e);
      ipcRenderer.on("pi-agent:step", handler);
      return () => ipcRenderer.off("pi-agent:step", handler);
    },
    onUsage: (cb: (e: { sessionId: string; promptTokens: number; completionTokens: number; reasoningTokens?: number; breakdown?: unknown }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; promptTokens: number; completionTokens: number; reasoningTokens?: number; breakdown?: unknown }) => cb(e);
      ipcRenderer.on("pi-agent:usage", handler);
      return () => ipcRenderer.off("pi-agent:usage", handler);
    },
    /** Fired before each automatic retry on a transient error. delayMs is the backoff wait. */
    onRetry: (cb: (e: { sessionId: string; attempt: number; maxRetries: number; delayMs: number; error: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; attempt: number; maxRetries: number; delayMs: number; error: string }) => cb(e);
      ipcRenderer.on("pi-agent:retry", handler);
      return () => ipcRenderer.off("pi-agent:retry", handler);
    },
    /** Fired when the session starts or finishes an LLM-based compaction pass. */
    onCompact: (cb: (e: { sessionId: string; status: "start" | "end"; auto?: boolean }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; status: "start" | "end"; auto?: boolean }) => cb(e);
      ipcRenderer.on("pi-agent:compact", handler);
      return () => ipcRenderer.off("pi-agent:compact", handler);
    },
    /** Fired after a /compact slash command completes with the result. */
    onCompactResult: (cb: (e: { sessionId: string; messageCount: number; summary: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; messageCount: number; summary: string }) => cb(e);
      ipcRenderer.on("pi-agent:compact-result", handler);
      return () => ipcRenderer.off("pi-agent:compact-result", handler);
    },
    onSubagent: (cb: (e: { parentSessionId: string; childSessionId: string; status: "start" | "done"; result?: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { parentSessionId: string; childSessionId: string; status: "start" | "done"; result?: string }) => cb(e);
      ipcRenderer.on("pi-agent:subagent", handler);
      return () => ipcRenderer.off("pi-agent:subagent", handler);
    },
    /** Fired when the agent calls ensure_note in plan mode — carries the PRD note ID */
    onPlanNote: (cb: (e: { sessionId: string; noteId: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; noteId: string }) => cb(e);
      ipcRenderer.on("pi-agent:plan-note", handler);
      return () => ipcRenderer.off("pi-agent:plan-note", handler);
    },
    /** Fired after any note-write tool (patch_note, ensure_note, append_to_note) completes — delivers fresh note content for live task-list updates */
    onNoteUpdated: (cb: (e: { sessionId: string; noteId: string; content: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; noteId: string; content: string }) => cb(e);
      ipcRenderer.on("pi-agent:note-updated", handler);
      return () => ipcRenderer.off("pi-agent:note-updated", handler);
    },
    /** Fired when the session mode switches (plan → execute after approval) */
    onModeChange: (cb: (e: { sessionId: string; mode: "plan" | "execute"; planNoteId?: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; mode: "plan" | "execute"; planNoteId?: string }) => cb(e);
      ipcRenderer.on("pi-agent:mode-change", handler);
      return () => ipcRenderer.off("pi-agent:mode-change", handler);
    },
    /** Approve the plan — switches session to execute mode and starts implementation */
    approvePlan: (req: unknown) => ipcRenderer.send("pi-agent:approve-plan", req),
    /** Fired when the agent calls ask_questions — renderer should render an inline form */
    onAskQuestions: (cb: (e: { sessionId: string; questions: Array<{ id: string; label: string; prompt: string }> }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; questions: Array<{ id: string; label: string; prompt: string }> }) => cb(e);
      ipcRenderer.on("pi-agent:ask-questions", handler);
      return () => ipcRenderer.off("pi-agent:ask-questions", handler);
    },
    /** List all persisted pi sessions for a project (project-scoped history) */
    listSessions:   (projectId: string) => invoke("db:piSession:list", { projectId }),
    /** Persist a new pi session row to SQLite */
    createSession:  (args: unknown) => invoke("db:piSession:create", args),
    /** Delete a pi session and all its messages from SQLite */
    deleteSession:  (id: string) => invoke("db:piSession:delete", { id }),
    /** Fetch the full message transcript for a session */
    getMessages:    (sessionId: string) => invoke("db:piSession:messages", { sessionId }),
    /** Bulk-save the full message array for a session (replaces existing rows) */
    saveMessages:   (sessionId: string, messages: unknown[]) => invoke("db:piSession:saveMessages", { sessionId, messages }),
    /** Restore LLM context for a session (loads history into main-process Map) — fire-and-forget */
    restoreContext: (sessionId: string) => ipcRenderer.send("pi-agent:restore-context", { sessionId }),
    /**
     * Preview the assembled system prompt and discovered skills for a given cwd.
     * Used by Settings → Coding Agents to show what the agent will receive.
     */
    previewPrompt: (req: { cwd: string; projectId?: string; mode?: "plan" | "execute" }) =>
      invoke<{ systemPrompt: string; skills: Array<{ name: string; description: string; filePath: string; dirPath: string; license?: string; compatibility?: string }> }>(
        "pi-agent:preview-prompt", req
      ),
    /** Dynamically switch a session's mode */
    setMode: (sessionId: string, mode: "plan" | "execute") =>
      ipcRenderer.send("pi-agent:set-mode", { sessionId, mode }),
    /** Approve or deny a pending tool call */
    respondTool: (sessionId: string, callId: string, approved: boolean) =>
      ipcRenderer.send("pi-agent:respond-tool", { sessionId, callId, approved }),
    /** Listen for tool call confirmation requests */
    onToolConfirmRequired: (cb: (e: { sessionId: string; callId: string; name: string; label: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; callId: string; name: string; label: string }) => cb(e);
      ipcRenderer.on("pi-agent:tool-confirm-required", handler);
      return () => ipcRenderer.off("pi-agent:tool-confirm-required", handler);
    },
  },

  // ── AI Tool Builder (streaming builder session) ───────────────
  toolBuilder: {
    /** Send a builder prompt (and optionally a user-supplied secret). Fire-and-forget. */
    prompt: (req: { sessionId: string; workspaceId: string; message: string; secret?: { header: string; value: string } }) =>
      ipcRenderer.send("tool-builder:prompt", req),
    /** Abort the current in-flight builder turn. */
    abort: (sessionId: string) => ipcRenderer.send("tool-builder:abort", { sessionId }),
    /** Destroy a builder session (clears its in-memory state + temp secrets). */
    end: (sessionId: string) => ipcRenderer.send("tool-builder:end", { sessionId }),

    onToken: (cb: (e: { sessionId: string; delta: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; delta: string }) => cb(e);
      ipcRenderer.on("tool-builder:token", handler);
      return () => ipcRenderer.off("tool-builder:token", handler);
    },
    onStep: (cb: (e: { sessionId: string; name: string; args: Record<string, unknown> }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; name: string; args: Record<string, unknown> }) => cb(e);
      ipcRenderer.on("tool-builder:step", handler);
      return () => ipcRenderer.off("tool-builder:step", handler);
    },
    onProbeHost: (cb: (e: { sessionId: string; host: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; host: string }) => cb(e);
      ipcRenderer.on("tool-builder:probe-host", handler);
      return () => ipcRenderer.off("tool-builder:probe-host", handler);
    },
    onProposal: (cb: (e: { sessionId: string; toolType: "service" | "mcp"; config: unknown }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; toolType: "service" | "mcp"; config: unknown }) => cb(e);
      ipcRenderer.on("tool-builder:proposal", handler);
      return () => ipcRenderer.off("tool-builder:proposal", handler);
    },
    onDone: (cb: (e: { sessionId: string; error?: string; aborted?: boolean }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; error?: string; aborted?: boolean }) => cb(e);
      ipcRenderer.on("tool-builder:done", handler);
      return () => ipcRenderer.off("tool-builder:done", handler);
    },
  },

  // ── On-Device Llama Server ───────────────
  llama: {
    models: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      list: () => invoke<any[]>("llama:models:list"),
      install: (modelId: string, useMirror?: boolean) => invoke<void>("llama:models:install", { modelId, useMirror }),
      remove: (modelId: string) => invoke<void>("llama:models:remove", { modelId }),
      clearInactive: () => invoke<void>("llama:models:clearInactive"),
      onProgress: (cb: (e: { modelId: string; progress: number; speed?: string; bytesReceived: number; bytesTotal: number; status: string; error?: string }) => void) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handler = (_: any, e: any) => cb(e);
        ipcRenderer.on("llama:download-progress", handler);
        return () => {
          ipcRenderer.off("llama:download-progress", handler);
        };
      }
    },
    binary: {
      install: () => invoke<void>("llama:binary:install"),
      checkForUpdates: () => invoke<{ updateAvailable: boolean; currentVersion: string | null; latestVersion: string | null }>("llama:binary:check-update"),
      onProgress: (cb: (e: { progress: number; speed?: string; status: string; error?: string }) => void) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handler = (_: any, e: any) => cb(e);
        ipcRenderer.on("llama:binary-progress", handler);
        return () => {
          ipcRenderer.off("llama:binary-progress", handler);
        };
      }
    },
    server: {
      start: (modelId: string, contextLimit?: number) => invoke<{ port: number }>("llama:server:start", { modelId, contextLimit }),
      stop: () => invoke<void>("llama:server:stop"),
      status: () => invoke<{
        running: boolean;
        port: number | null;
        activeModelId: string | null;
        defaultModelId: string | null;
        installed: boolean;
        error: string | null;
      }>("llama:server:status"),
      setDefault: (modelId: string) => invoke<{ success: boolean }>("llama:server:setDefault", { modelId }),
    }
  },
  // ── Embeddings (local semantic search + knowledge graph) ────
  embeddings: {
    status: () => invoke<{
      running: boolean;
      port: number | null;
      activeModelId: string | null;
      defaultModelId: string | null;
      installed: boolean;
      error: string | null;
      reindexInProgress: boolean;
      recomputeInProgress: boolean;
      lastReindexDone: number;
      lastReindexTotal: number;
      lastRecomputeDone: number;
      lastRecomputeTotal: number;
    }>("embeddings:status"),
    stop: () => invoke<void>("embeddings:stop"),
    needsReindex: () => invoke<{ needed: boolean; reason: string | null }>("embeddings:needsReindex"),
    projections: (workspaceId: string) => invoke<{
      rows: Array<{ noteId: string; dimX: number; dimY: number; projStale: number; embeddedAt: string; model: string }>;
      anyStale: boolean;
      model: string;
    }>("embeddings:projections", { workspaceId }),
    reindex: (workspaceId: string, noteIds?: string[], model?: string) => invoke<{
      indexed: number;
      skipped: number;
      total: number;
    }>("db:embeddings:reindex", { workspaceId, noteIds, model }),
    search: (workspaceId: string, queryText: string, opts?: {
      queryNoteId?: string;
      k?: number;
      excludeIds?: string[];
      model?: string;
    }) => invoke<Array<{ noteId: string; title: string; score: number; sectionTitle: string }>>(
      "db:embeddings:search",
      { workspaceId, queryText, ...opts },
    ),
    recomputeProjections: (workspaceId: string, model?: string) => invoke<{
      projected: number;
      total: number;
    }>("db:embeddings:recomputeProjections", { workspaceId, model }),
    models: {
      list: () => invoke<Array<{
        id: string;
        name: string;
        repo: string;
        dim: number;
        maxTokens: number;
        sizeBytes: number;
        status: "not_downloaded" | "downloading" | "installed" | "error";
        downloadProgress: number;
        downloadSpeed?: string;
        error?: string;
      }>>("embeddings:models:list"),
      install: (modelId: string) => invoke<{ ok: boolean }>("embeddings:models:install", { modelId }),
      remove: (modelId: string) => invoke<{ ok: boolean }>("embeddings:models:remove", { modelId }),
      setDefault: (modelId: string) => invoke<{ ok: boolean }>("embeddings:models:setDefault", { modelId }),
      onProgress: (cb: (e: {
        modelId: string;
        status: string;
        file?: string;
        progress?: number;
        loaded?: number;
        total?: number;
        error?: string;
      }) => void) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handler = (_: any, e: any) => cb(e);
        ipcRenderer.on("embeddings:download-progress", handler);
        return () => {
          ipcRenderer.off("embeddings:download-progress", handler);
        };
      },
    },
    getSettings: () => invoke<{ enabled?: boolean; modelId?: string } | null>("app:getEmbeddingsSettings"),
    saveSettings: (config: { enabled?: boolean; modelId?: string }) => invoke<{ ok: boolean }>(
      "app:saveEmbeddingsSettings",
      { config },
    ),
  },
  // ── Unified Runtime (embeddings + LLM) ───────────
  runtime: {
    status: () => invoke<{
      embeddings: { healthy: boolean; model: string | null; loaded: boolean };
      llm: { healthy: boolean; model: string | null; loaded: boolean; port: number | null };
    }>("runtime:status"),
    stop: () => invoke<{ ok: boolean }>("runtime:stop"),
    onProgress: (cb: (e: {
      modelId: string;
      status: string;
      file?: string;
      progress?: number;
      loaded?: number;
      total?: number;
    }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: any) => cb(e);
      ipcRenderer.on("runtime:download-progress", handler);
      return () => {
        ipcRenderer.off("runtime:download-progress", handler);
      };
    },
    embeddings: {
      status: () => invoke<{
        running: boolean;
        port: number | null;
        activeModelId: string | null;
        defaultModelId: string | null;
        installed: boolean;
        error: string | null;
        reindexInProgress: boolean;
        recomputeInProgress: boolean;
        lastReindexDone: number;
        lastReindexTotal: number;
        lastRecomputeDone: number;
        lastRecomputeTotal: number;
      }>("runtime:embeddings:status"),
      ensureStarted: () => invoke<{ ok: boolean }>("runtime:embeddings:ensureStarted"),
      models: () => invoke<{ models: Array<Record<string, unknown>> }>("runtime:embeddings:models"),
      install: (modelId: string) => invoke<{ ok: boolean }>("runtime:embeddings:install", { modelId }),
      remove: (modelId: string) => invoke<{ ok: boolean }>("runtime:embeddings:remove", { modelId }),
      setDefault: (modelId: string) => invoke<{ ok: boolean }>("runtime:embeddings:setDefault", { modelId }),
      onProgress: (cb: (e: {
        modelId: string;
        status: string;
        file?: string;
        progress?: number;
        loaded?: number;
        total?: number;
        error?: string;
      }) => void) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handler = (_: any, e: any) => cb(e);
        ipcRenderer.on("runtime:download-progress", handler);
        return () => {
          ipcRenderer.off("runtime:download-progress", handler);
        };
      },
    },
    llm: {
      models: () => invoke<{ models: Array<Record<string, unknown>> }>("runtime:llm:models"),
      install: (modelId: string, useMirror?: boolean) => invoke<{ ok: boolean }>("runtime:llm:install", { modelId, useMirror }),
      remove: (modelId: string) => invoke<{ ok: boolean }>("runtime:llm:remove", { modelId }),
      clearInactive: () => invoke<{ ok: boolean }>("runtime:llm:clearInactive"),
      onProgress: (cb: (e: {
        modelId: string;
        progress: number;
        speed?: string;
        loaded: number;
        total: number;
        status: string;
        error?: string;
      }) => void) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handler = (_: any, e: any) => cb(e);
        ipcRenderer.on("runtime:download-progress", handler);
        return () => {
          ipcRenderer.off("runtime:download-progress", handler);
        };
      },
      binary: {
        install: () => invoke<{ ok: boolean }>("runtime:llm:binary:install"),
        checkForUpdates: () => invoke<{ updateAvailable: boolean; currentVersion: string | null; latestVersion: string | null }>("runtime:llm:checkUpdate"),
        onProgress: (cb: (e: { progress: number; speed?: string; status: string; error?: string }) => void) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const handler = (_: any, e: any) => cb(e);
          ipcRenderer.on("runtime:binary-progress", handler);
          return () => {
            ipcRenderer.off("runtime:binary-progress", handler);
          };
        },
      },
      server: {
        start: (modelId: string, contextLimit?: number) => invoke<{ port: number }>("runtime:llm:start", { modelId, contextLimit }),
        stop: () => invoke<{ ok: boolean }>("runtime:llm:stop"),
        status: () => invoke<{
          running: boolean;
          port: number | null;
          activeModelId: string | null;
          defaultModelId: string | null;
          binaryInstalled: boolean;
        }>("runtime:llm:status"),
        setDefault: (modelId: string) => invoke<{ ok: boolean }>("runtime:llm:server:setDefault", { modelId }),
      },
    },
  },
  // ── Mobile Access ────────────────────────────────
  mobile: {
    status: () => invoke<{
      running: boolean;
      url: string;
      qrCode: string;
      pin: string;
    }>("mobile:status"),
    saveSettings: (newSettings: Record<string, unknown>) => invoke<{
      running: boolean;
      url: string;
      qrCode: string;
      pin: string;
    }>("mobile:saveSettings", newSettings),
    regeneratePin: () => invoke<{
      running: boolean;
      url: string;
      qrCode: string;
      pin: string;
    }>("mobile:regeneratePin"),
    onStatusChanged: (cb: (status: {
      running: boolean;
      url: string;
      qrCode: string;
      pin: string;
    }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, status: any) => cb(status);
      ipcRenderer.on("mobile:status-changed", handler);
      return () => ipcRenderer.off("mobile:status-changed", handler);
    }
  }
} as const;

contextBridge.exposeInMainWorld("electron", api);

// ── Type export for the renderer ────────────────
// Import this type in the renderer to get full type safety on window.electron
export type ElectronAPI = typeof api;
