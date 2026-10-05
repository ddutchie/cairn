/**
 * Cairn — Preload script
 *
 * Exposes a typed `window.electron` API to the renderer via contextBridge.
 * Only whitelisted channels are accessible — the renderer has no access
 * to Node.js or Electron internals directly.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { SessionEventEnvelope } from "../shared/agent/session-event";
import type { SessionProjection } from "../shared/agent/session-projection";
import type { IpcChannel, IpcArgs, IpcReturn, IpcEventChannel, IpcEvents } from "../shared/ipc/contract";
import type { ChatPopoutPayload } from "../shared/agent/chat-popout";
import type { NoteCreateInput, NotePatch } from "../shared/types/notes";
import type {
  AutomationInput, AutomationPatch, AutomationRequirement, AutomationRunEvent,
} from "../shared/types/automations";
import type { CardCreateInput, CardPatch, ColumnCreateInput, ColumnPatch } from "../shared/types/board";
import type {
  ProjectCreateInput, ProjectPatch, ProjectSettings, TagCreateInput, TagPatch, WorkspaceCreateInput, WorkspacePatch,
} from "../shared/types/workspace";
import type { CodingSessionCreateInput, PutMessageFeedbackInput } from "../shared/agent/session-wire";
import type { ChatThreadUpsertInput } from "../shared/types/chat";
import type { FlowAiConfig, FlowEdgeCreateInput, FlowNodeCreateInput, FlowNodePatch } from "../shared/types/flow";
import type { GitPathSelection, GitStashAction } from "../shared/types/git";
import type { GraphQueryFilters } from "../shared/types/graph";
import type { GraphEdgeType } from "../shared/types/domain";
import type { SlashCommandCreateInput, SlashCommandPatch } from "../shared/types/workspace";
import type { CustomServiceConfig, McpServerConfig, SecretToolType, ToolAttachment } from "../shared/types/tools";
import type {
  AgentSpawnInput, CodingAgentInput, ModelPtyEvent, PtyDataEvent, PtyExitEvent,
} from "../shared/types/coding-agent";
import type { UsageRangeArgs } from "../shared/types/usage";
import type { ConflictResolution, SyncStatus } from "../shared/types/sync";
import type { EmbeddingDownloadProgress } from "../shared/types/embeddings";
import type { MobileStatus } from "../shared/types/runtime";
import type {
  UserStyleDoneEvent, UserStyleGenerationInput, UserStyleSaveInput, UserStyleStep, UserStyleStreamRequest,
  UserStyleToolCallDoneEvent, UserStyleToolCallEvent,
} from "../shared/types/user-style";
import type { AiEndpoint, AiRequestConfig, MigrationProgress, ModelPrice, UpdateAvailableInfo } from "../shared/types/app";

/**
 * Invoke a channel in the typed IPC contract (shared/ipc/contract.ts) and
 * unwrap its envelope: every handler returns { data } | { error } via handle(),
 * so callers receive the typed result directly or a rejection on error.
 */
function invokeContract<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcReturn<C>> {
  return ipcRenderer.invoke(channel, args[0]).then((result: { data: IpcReturn<C> } | { error: string }) => {
    if (result && typeof result === "object" && "error" in result) throw new Error(result.error);
    return result.data;
  });
}

/** Subscribe to a contract push event; returns the unsubscribe function. */
function onIpcEvent<E extends IpcEventChannel>(channel: E, cb: (payload: IpcEvents[E]) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: IpcEvents[E]) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.off(channel, handler); };
}

const api = {
  // ── Full snapshot ────────────────────────────
  snapshot: (opts?: { noteBodies?: boolean }) => invokeContract("db:snapshot", opts),
  // ── Change feed (cursor-based incremental refresh) ──
  changes: {
    get: (args: { since: number | null; feedId: string | null }) => invokeContract("db:changes:get", args),
  },
  hasData:  () => invokeContract("db:hasData"),

  // ── Workspaces ───────────────────────────────
  workspace: {
    list:   () => invokeContract("db:workspace:list"),
    create: (input: WorkspaceCreateInput) => invokeContract("db:workspace:create", input),
    update: (id: string, patch: WorkspacePatch) => invokeContract("db:workspace:update", { id, patch }),
  },

  // ── Projects ─────────────────────────────────
  project: {
    list:   (workspaceId?: string) => invokeContract("db:project:list", { workspaceId }),
    create: (input: ProjectCreateInput) => invokeContract("db:project:create", input),
    update: (id: string, patch: ProjectPatch) => invokeContract("db:project:update", { id, patch }),
    updateSettings: (id: string, settings: Partial<Record<keyof ProjectSettings, unknown>>) =>
      invokeContract("db:project:updateSettings", { id, settings }),
    delete: (id: string) => invokeContract("db:project:delete", { id }),
    merge:  (sourceId: string, targetId: string) => invokeContract("db:project:merge", { sourceId, targetId }),
  },

  // ── Notes ────────────────────────────────────
  note: {
    list:         (projectId?: string) => invokeContract("db:note:list", { projectId }),
    create:       (note: NoteCreateInput) => invokeContract("db:note:create", note),
    update:       (id: string, patch: NotePatch) => invokeContract("db:note:update", { id, patch }),
    delete:       (id: string) => invokeContract("db:note:delete", { id }),
    moveToFolder: (id: string, folder: string) => invokeContract("db:note:moveToFolder", { id, folder }),
    // workspaceId is derived from the target project by the handler; accepted for
    // backwards-compatible call sites but no longer required.
    moveToProject: (id: string, projectId: string, _workspaceId?: string) =>
      invokeContract("db:note:moveToProject", { id, projectId }),
    // Lazy bodies: the renderer store holds note metadata only (Electron).
    bodies: (ids: string[]) => invokeContract("db:note:bodies:get", { ids }),
    search: (query: string, projectId?: string) => invokeContract("db:note:search", { query, projectId }),
    backlinks: (noteId: string) => invokeContract("db:note:backlinks:list", { noteId }),
    /** The user has seen this note's "what's new" changes. */
    clearChangeMark: (id: string) => invokeContract("db:note:changeMark:clear", { id }),
  },

  // ── Board columns ─────────────────────────────
  column: {
    list:   (projectId?: string) => invokeContract("db:column:list", { projectId }),
    create: (input: ColumnCreateInput) => invokeContract("db:column:create", input),
    update: (id: string, patch: ColumnPatch) => invokeContract("db:column:update", { id, patch }),
    delete: (id: string) => invokeContract("db:column:delete", { id }),
  },

  // ── Task cards ────────────────────────────────
  card: {
    list:         (opts?: { projectId?: string; columnId?: string }) => invokeContract("db:card:list", opts),
    create:       (input: CardCreateInput) => invokeContract("db:card:create", input),
    update:       (id: string, patch: CardPatch) => invokeContract("db:card:update", { id, patch }),
    moveToProject:(id: string, projectId: string, columnId: string, order: number) =>
      invokeContract("db:card:moveToProject", { id, projectId, columnId, order }),
    delete:       (id: string) => invokeContract("db:card:delete", { id }),
    archiveDone:  (columnId: string) => invokeContract("db:cards:archive-done", { columnId }),
    addBlocker:   (cardId: string, blockerCardId: string) => invokeContract("db:card:addBlocker", { cardId, blockerCardId }),
    removeBlocker:(cardId: string, blockerCardId: string) => invokeContract("db:card:removeBlocker", { cardId, blockerCardId }),
    ready:        (projectId?: string) => invokeContract("db:card:ready", { projectId }),
  },

  // ── Idea Flow ────────────────────────────────
  flow: {
    get:         (projectId: string) => invokeContract("db:flow:get", { projectId }),
    node: {
      create:    (node: FlowNodeCreateInput) => invokeContract("db:flow:node:create", node),
      update:    (id: string, patch: FlowNodePatch) => invokeContract("db:flow:node:update", { id, patch }),
      delete:    (id: string) => invokeContract("db:flow:node:delete", { id }),
      summarize: (nodeId: string, config: FlowAiConfig) => invokeContract("db:flow:node:summarize", { nodeId, config }),
    },
    edge: {
      create: (edge: FlowEdgeCreateInput) => invokeContract("db:flow:edge:create", edge),
      delete: (id: string) => invokeContract("db:flow:edge:delete", { id }),
    },
    url: {
      fetch: (url: string) => invokeContract("db:flow:url:fetch", { url }),
    },
  },

  // ── Tags ─────────────────────────────────────
  tag: {
    list:   (workspaceId?: string) => invokeContract("db:tag:list", { workspaceId }),
    create: (input: TagCreateInput) => invokeContract("db:tag:create", input),
    update: (id: string, patch: TagPatch) => invokeContract("db:tag:update", { id, patch }),
    delete: (id: string) => invokeContract("db:tag:delete", { id }),
  },

  // ── Slash commands ───────────────────────────
  command: {
    list:   (workspaceId?: string) => invokeContract("db:command:list", { workspaceId }),
    create: (input: SlashCommandCreateInput) => invokeContract("db:command:create", input),
    update: (id: string, patch: SlashCommandPatch) => invokeContract("db:command:update", { id, patch }),
    delete: (id: string) => invokeContract("db:command:delete", { id }),
  },

  // ── Heartbeat automations ─────────────────────
  automation: {
    list:   (workspaceId: string) => invokeContract("db:automation:list", { workspaceId }),
    get:    (id: string) => invokeContract("db:automation:get", { id }),
    create: (input: AutomationInput) => invokeContract("db:automation:create", input),
    update: (id: string, patch: AutomationPatch) => invokeContract("db:automation:update", { id, patch }),
    delete: (id: string) => invokeContract("db:automation:delete", { id }),
    runs:   (automationId: string, limit?: number) => invokeContract("db:automation:runs", { automationId, limit }),
    recentRuns: (workspaceId: string, projectId?: string | null, limit?: number) =>
      invokeContract("db:automation:recentRuns", { workspaceId, projectId: projectId ?? null, limit }),
    runNow: (id: string) => invokeContract("db:automation:runNow", { id }),
    /** Daily automation budget (USD) + today's recorded automation spend. */
    budget: {
      get: () => invokeContract("db:automation:budget:get"),
      set: (usd: number | null) => invokeContract("db:automation:budget:set", { usd }),
    },
    runningCount: () => invokeContract("db:automation:runningCount"),
    /** Approve/deny a pending tool approval for a running automation (Cordis). */
    approve: (callId: string, approved: boolean, grant?: "session" | "always") =>
      invokeContract("automation:approve", { callId, approved, grant }),
    folder: (id: string) => invokeContract("db:automation:folder", { id }),
    syncFromManifest: (id: string) => invokeContract("db:automation:syncFromManifest", { id }),
    files: (id: string) => invokeContract("db:automation:files", { id }),
    runLog: (runId: string) => invokeContract("db:automation:runLog", { runId }),
    /** Live run activity (tokens/tools/thought) for the "watch this run" view. */
    onRunEvent: (cb: (payload: AutomationRunEvent) => void) => onIpcEvent("automation:run", cb),
    env: {
      get: (automationId: string) => invokeContract("db:automation:env", { automationId }),
      set: (automationId: string, name: string, value: string, secret: boolean) =>
        invokeContract("db:automation:env:set", { automationId, name, value, secret }),
      delete: (automationId: string, name: string) => invokeContract("db:automation:env:delete", { automationId, name }),
    },
    /** Installed/attached status per required connector (New Automation browse guard). */
    checkRequirements: (workspaceId: string, projectId: string, requires: AutomationRequirement[]) =>
      invokeContract("db:automation:checkRequirements", { workspaceId, projectId, requires }),
    preview: (scheduleKind: string, scheduleExpr: string, timezone?: string | null) =>
      invokeContract("db:automation:preview", { scheduleKind, scheduleExpr, timezone }),
  },

  // ── Approval inbox ────────────────────────────

  // ── Chat ─────────────────────────────────────
  chat: {
    threads:       (workspaceId: string) => invokeContract("db:chat:threads", { workspaceId }),
    sessionMessages: (threadId: string) => invokeContract("db:chat:sessionMessages", { threadId }),
    upsertThread:  (input: ChatThreadUpsertInput) => invokeContract("db:chat:upsertThread", input),
    deleteThread:  (threadId: string) => invokeContract("db:chat:deleteThread", { threadId }),
    clearThreadMessages: (threadId: string) => invokeContract("db:chat:clearThreadMessages", { threadId }),
    clearAllThreads: (workspaceId: string, projectId?: string) => invokeContract("db:chat:clearAllThreads", { workspaceId, projectId }),
    compactThread: (req: IpcArgs<"chat:compactThread">[0]) => invokeContract("chat:compactThread", req),
    summarizeTranscript: (req: IpcArgs<"chat:summarizeTranscript">[0]) => invokeContract("chat:summarizeTranscript", req),
    // ── Pop-out window ──────────────────────────
    /** Called by main window: sends current chat state, triggers window creation. */
    popOut: (payload: ChatPopoutPayload) => invokeContract("chat:popOut", payload),
    /** Called by pop-out page: signals readiness, returns the shared session id. */
    popoutReady: () => invokeContract("chat:popoutReady"),
    /** Called by pop-out page: closes the window; session state is not copied. */
    popIn: (payload: { sessionId: string }) => invokeContract("chat:popIn", payload),
    /** Called by main window: asks the pop-out to return (relayed via main process). */
    requestPopIn: () => invokeContract("chat:requestPopIn"),
    /** Listener on the main window: received when pop-in completes with final state. */
    onChatPoppedIn: (cb: (payload: IpcEvents["chat:poppedIn"]) => void) => onIpcEvent("chat:poppedIn", cb),
    /** Listener on the main window: pop-out closed unexpectedly (e.g. Cmd+W). */
    onChatPoppedOutClosed: (cb: () => void) => onIpcEvent("chat:poppedOutClosed", () => cb()),
    /** Listener on the pop-out page: received when main window requests pop-in. */
    onChatRequestPopIn: (cb: () => void) => onIpcEvent("chat:requestPopIn", () => cb()),
    /** Listener on the pop-out page: received when main window pushes an updated session (C2 race fix). */
    onChatSessionUpdated: (cb: (payload: ChatPopoutPayload) => void) => onIpcEvent("chat:sessionUpdated", cb),
  },

  // ── Knowledge Graph ───────────────────────────
  graph: {
    get:       (workspaceId: string, filters?: GraphQueryFilters) => invokeContract("db:graph:get", { workspaceId, filters }),
    neighbors: (workspaceId: string, nodeId: string, depth?: number, edgeTypes?: GraphEdgeType[]) =>
                 invokeContract("db:graph:neighbors", { workspaceId, nodeId, depth, edgeTypes }),
    recompute: (workspaceId: string, entityIds?: string[]) => invokeContract("db:graph:recompute", { workspaceId, entityIds }),
  },

  // ── AI helpers ────────────────────────────────
  ai: {
    generatePrd: (args: IpcArgs<"ai:generatePrd">[0]) => invokeContract("ai:generatePrd", args),
    generateCommitMessage: (args: { diff: string; config: AiRequestConfig }) =>
      invokeContract("ai:generateCommitMessage", args),
    generatePrDescription: (args: { diff: string; config: AiRequestConfig; template?: string }) =>
      invokeContract("ai:generatePrDescription", args),
    explainArchitecture: (args: { summary: string; config: AiRequestConfig }) =>
      invokeContract("ai:explainArchitecture", args),
    fetchModels: (args: AiEndpoint) => invokeContract("ai:fetchModels", args),
    fetchKeyInfo: (args: AiEndpoint) => invokeContract("ai:fetchKeyInfo", args),
  },

  // ── Usage statistics (LLM/agent usage log) ─────
  usage: {
    overview: (args: UsageRangeArgs) => invokeContract("usage:overview", args),
    recent: (args: UsageRangeArgs & { limit?: number }) => invokeContract("usage:recent", args),
    threads: (args: UsageRangeArgs & { limit?: number }) => invokeContract("usage:threads", args),
    /** Destructive — delete recorded usage rows scoped to the workspace filter. */
    clear: (args: UsageRangeArgs) => invokeContract("usage:clear", args),
    /** Push the models.dev per-1M pricing map (used for cost estimation). */
    setPricing: (map: Record<string, ModelPrice>) => invokeContract("app:modelPricing", map),
    /** Push model ids that declare they don't support temperature control. */
    setNoTemperatureModels: (ids: string[]) => invokeContract("app:noTemperatureModels", ids),
  },

  // ── App paths ─────────────────────────────────
  mcpServerPath: () => invokeContract("app:mcpServerPath"),
  latestChangelog: () => invokeContract("app:latestChangelog"),

  // ── Reveal note in Finder / Explorer ─────────
  revealNote: (noteId: string, projectId: string) => invokeContract("app:revealNote", { noteId, projectId }),

  // ── Export note as PDF ────────────────────────
  exportNotePdf: (title: string, html: string, options?: { returnBuffer?: boolean; theme?: "light" | "dark"; fontFamily?: string }) =>
    invokeContract("app:exportNotePdf", { title, html, options }),

  // ── Export note / project as Markdown ─────────
  exportMarkdown: (kind: "note" | "project", id: string, options?: { returnText?: boolean }) =>
    invokeContract("app:exportMarkdown", { kind, id, returnText: options?.returnText }),

  // ── Open a URL in the system default browser ──
  openExternal: (url: string) => ipcRenderer.send("app:openExternal", url),

  // ── Asset upload (pasted images) ──────────────
  // data is an ArrayBuffer — Electron's structured-clone transfers it
  // natively without serialising to a JSON number array.
  uploadAsset: (filename: string, data: ArrayBuffer) => invokeContract("app:uploadAsset", { filename, data }),
  revealAssets: () => invokeContract("app:revealAssets"),
  /** Orphaned GGUFs/binaries from the retired built-in engine (Settings → Data). */
  llmLeftovers: () => invokeContract("app:llmLeftovers"),
  clearLlmLeftovers: () => invokeContract("app:clearLlmLeftovers"),

  // ── Workspace folder ──────────────────────────
  selectWorkspaceFolder: () => invokeContract("app:selectWorkspaceFolder"),
  getWorkspacePath: () => invokeContract("app:getWorkspacePath"),
  needsWorkspaceSetup: () => invokeContract("app:needsWorkspaceSetup"),
  /** True when running unpackaged — gates dev-only UI (MCP dsh-path toggle). */
  isDev: () => invokeContract("app:isDev"),
  setTheme: (theme: string) => invokeContract("app:setTheme", theme),
  setAccent: (accent: string) => invokeContract("app:setAccent", accent),
  initWorkspace: (workspacePath: string, excludedFolders?: string[]) =>
    invokeContract("app:initWorkspace", { workspacePath, excludedFolders }),
  rescanWorkspace: (workspaceId?: string, excludedFolders?: string[]) =>
    invokeContract("app:rescanWorkspace", { workspaceId, excludedFolders }),
  rollbackImport: (projectIds: string[]) => invokeContract("app:rollbackImport", { projectIds }),
  probeWorkspaceFolder: (folder: string) => invokeContract("app:probeWorkspaceFolder", { folder }),
  relaunch: () => invokeContract("app:relaunch"),
  resetAllData: () => invokeContract("app:reset"),
  getAiSettings: () => invokeContract("app:getAiSettings"),
  saveAiSettings: (config: Record<string, unknown>) => invokeContract("app:saveAiSettings", { config }),
  // User writing style (persona + full guide + cheat sheet) — Settings → Writing Style.
  getUserStyle: () => invokeContract("user-style:get"),
  saveUserStyle: (input: UserStyleSaveInput) => invokeContract("user-style:save", { input }),
  clearUserStyle: () => invokeContract("user-style:clear"),
  generateUserStyle: (step: UserStyleStep, input: UserStyleGenerationInput) =>
    invokeContract("user-style:generate", { step, input }),
  // Streaming generation (wizard) — fire-and-forget; listen via onUserStyle*.
  // Credentials are resolved main-side (resolveChatConfig), never sent here.
  generateUserStyleStream: (req: UserStyleStreamRequest) => ipcRenderer.send("user-style:generateStream", req),
  abortUserStyleStream: () => ipcRenderer.send("user-style:abort"),
  onUserStyleToken: (cb: (e: { delta: string }) => void) => onIpcEvent("user-style:token", cb),
  onUserStyleToolCall: (cb: (e: UserStyleToolCallEvent) => void) => onIpcEvent("user-style:tool-call", cb),
  onUserStyleToolCallDone: (cb: (e: UserStyleToolCallDoneEvent) => void) => onIpcEvent("user-style:tool-call-done", cb),
  onUserStyleDone: (cb: (e: UserStyleDoneEvent) => void) => onIpcEvent("user-style:done", cb),
  getAgentSettings: () => invokeContract("app:getAgentSettings"),
  saveAgentSettings: (config: Record<string, unknown>) => invokeContract("app:saveAgentSettings", { config }),
  getTheme: () => invokeContract("app:getTheme"),
  saveTheme: (theme: string) => invokeContract("app:saveTheme", { theme }),
  getFontScale: () => invokeContract("app:getFontScale"),
  saveFontScale: (fontScale: number) => invokeContract("app:saveFontScale", { fontScale }),
  platform: process.platform as "darwin" | "win32" | "linux",

  /** Global quick-capture shortcut / tray item fired — open the capture dialog. */
  onQuickCapture: (cb: () => void) => onIpcEvent("app:quick-capture", cb),

  // ── Migrations ────────────────────────────────
  checkMigrations: () => invokeContract("app:checkMigrations"),
  runMigration: (migrationId: string) => invokeContract("app:runMigration", { migrationId }),
  onMigrationProgress: (cb: (e: MigrationProgress) => void) => onIpcEvent("app:migrationProgress", cb),

  // ── Auto-updater ──────────────────────────────
  updater: {
    onUpdateAvailable: (cb: (info: UpdateAvailableInfo) => void) => onIpcEvent("updater:update-available", cb),
    onUpdateDownloaded: (cb: () => void) => onIpcEvent("updater:update-downloaded", cb),
    install: () => invokeContract("updater:install"),
  },

  // ── DB change notifications (from MCP writes) ─
  onDbChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("db:changed", handler);
    return () => ipcRenderer.off("db:changed", handler);
  },

  // ── Desktop sync (synced-folder oplog: connect folder + manual sync) ──
  sync: {
    getFolder: () => invokeContract("sync:getFolder"),
    selectFolder: () => invokeContract("sync:selectFolder"),
    clearFolder: () => invokeContract("sync:clearFolder"),
    now: () => invokeContract("sync:now"),
    // Current live status snapshot (state + pending/conflict counts + lastSyncAt).
    status: () => invokeContract("sync:status"),
    // Diagnostic: what's staged in sync_pending (entity/op/count + sample ids).
    pendingBreakdown: () => invokeContract("sync:pendingBreakdown"),
    // Subscribe to pushed status transitions. Returns an unsubscribe fn.
    onStatus: (cb: (status: SyncStatus) => void) => onIpcEvent("sync:status", cb),
    // Conflict copies awaiting manual resolution.
    listConflicts: () => invokeContract("sync:listConflicts"),
    resolveConflict: (copyId: string, action: ConflictResolution, mergedContent?: string) =>
      invokeContract("sync:resolveConflict", { copyId, action, mergedContent }),
    // Recent reconcile decisions — why a row was applied, skipped or deleted.
    activity: (limit?: number) => invokeContract("sync:activity", { limit }),
    // Notes deleted by another device that can still be restored. `total` may
    // exceed `rows.length` — never present the page size as the count.
    listRestorable: (limit?: number) => invokeContract("sync:listRestorable", { limit }),
    restoreNote: (id: string) => invokeContract("sync:restoreNote", { id }),
    // Retry the .md write for a restore whose DB half already succeeded.
    repairNoteFile: (id: string) => invokeContract("sync:repairNoteFile", { id }),
    // Peer devices on a different sync protocol version (behind = too old to honour deletes).
    peerProtocols: () => invokeContract("sync:peerProtocols"),
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
  mcpQuery: (tool: string, args: Record<string, unknown>) => invokeContract("db:mcpQuery", { tool, args }),

  // ── MCP notification badge ─────────────────────
  onMcpUnreadCount: (cb: (count: number) => void) => onIpcEvent("mcp:unread-count", cb),
  markMcpNotificationsRead: () => invokeContract("mcp:markNotificationsRead"),

  // ── In-app notification center ─────────────────
  notification: {
    list: (limit?: number) => invokeContract("db:notification:list", { limit }),
    count: () => invokeContract("db:notification:count"),
    markRead: (id: string) => invokeContract("db:notification:markRead", { id }),
    markAllRead: () => invokeContract("mcp:markNotificationsRead"),
    clear: () => invokeContract("db:notification:clear"),
  },

  // ── Agent / coding sessions ───────────────────
  agent: {
    getCodingAgents: () => invokeContract("agent:getCodingAgents"),
    saveCodingAgent: (agent: CodingAgentInput) => invokeContract("agent:saveCodingAgent", agent),
    deleteCodingAgent: (id: string) => invokeContract("agent:deleteCodingAgent", { id }),
    setDefaultAgent: (id: string) => invokeContract("agent:setDefaultAgent", { id }),

    readDir: (dirPath: string) => invokeContract("agent:readDir", { dirPath }),
    searchFiles: (dirPath: string, query: string) => invokeContract("agent:searchFiles", { dirPath, query }),
    readFile: (filePath: string) => invokeContract("agent:readFile", { filePath }),
    readFileBase64: (filePath: string) => invokeContract("agent:readFileBase64", { filePath }),
    writeFile: (filePath: string, content: string) => invokeContract("agent:writeFile", { filePath, content }),
    validateDirectory: (dirPath: string) => invokeContract("agent:validateDirectory", { dirPath }),
    gitDiff: (cwd: string) => invokeContract("agent:gitDiff", { cwd }),
    // Codebase index (Architecture tab) — read-only views over the semantic index.
    codebaseOverview: (folder: string) => invokeContract("agent:codebaseOverview", { folder }),
    codebaseGraph: (folder: string) => invokeContract("agent:codebaseGraph", { folder }),
    codebaseModuleGraph: (folder: string, depth?: number) => invokeContract("agent:codebaseModuleGraph", { folder, depth }),
    codebaseFileSymbols: (filePath: string) => invokeContract("agent:codebaseFileSymbols", { filePath }),
    codebaseRelations: (name: string, folder?: string) => invokeContract("agent:codebaseRelations", { name, folder }),
    codebaseReindex: (folder: string) => invokeContract("agent:codebaseReindex", { folder }),
    codebaseReindexFile: (folder: string, filePath: string) =>
      invokeContract("agent:codebaseReindexFile", { folder, filePath }),
    /** null when cancelled. */
    pickDirectory: () => invokeContract("agent:pickDirectory"),
    pickFile: () => invokeContract("agent:pickFile"),

    spawn: (input: AgentSpawnInput) => invokeContract("agent:spawn", input),
    spawnShell: (cwd: string) => invokeContract("agent:spawnShell", { cwd }),
    input: (sessionId: string, data: string) => invokeContract("agent:input", { sessionId, data }),
    resize: (sessionId: string, cols: number, rows: number) => invokeContract("agent:resize", { sessionId, cols, rows }),
    kill: (sessionId: string) => invokeContract("agent:kill", { sessionId }),

    // Agent-owned (model) terminals — observe only.
    modelTerminals: () => invokeContract("agent:modelTerminals"),
    onModelTerminal: (cb: (e: ModelPtyEvent) => void) => onIpcEvent("agent:model-terminal", cb),

    onData: (cb: (payload: PtyDataEvent) => void) => onIpcEvent("agent:data", cb),
    onExit: (cb: (payload: PtyExitEvent) => void) => onIpcEvent("agent:exit", cb),
  },

  // ── External tools (MCP servers + custom HTTP services) ───────
  tools: {
    listMcpServers: (workspaceId: string) => invokeContract("tools:listMcpServers", { workspaceId }),
    saveMcpServer: (server: Partial<McpServerConfig>) => invokeContract("tools:saveMcpServer", server),
    deleteMcpServer: (id: string) => invokeContract("tools:deleteMcpServer", { id }),
    testMcp: (id: string) => invokeContract("tools:testMcp", { id }),
    listMcpTools: (id: string) => invokeContract("tools:listMcpTools", { id }),

    listServices: (workspaceId: string) => invokeContract("tools:listServices", { workspaceId }),
    saveService: (service: Partial<CustomServiceConfig>) => invokeContract("tools:saveService", service),
    deleteService: (id: string) => invokeContract("tools:deleteService", { id }),
    testService: (id: string, sampleArgs?: Record<string, unknown>) =>
      invokeContract("tools:testService", { id, sampleArgs }),

    listAttachments: (projectId: string) => invokeContract("tools:listAttachments", { projectId }),
    setAttachment: (a: ToolAttachment) => invokeContract("tools:setAttachment", a),
    clearAttachment: (a: Omit<ToolAttachment, "enabled">) => invokeContract("tools:clearAttachment", a),

    // OAuth (remote MCP servers gated behind an authorization page).
    startMcpAuth: (id: string) => invokeContract("tools:startMcpAuth", { id }),
    mcpAuthStatus: (id: string) => invokeContract("tools:mcpAuthStatus", { id }),
    signOutMcp: (id: string) => invokeContract("tools:signOutMcp", { id }),
    /** Cancel an in-flight OAuth sign-in (user abandoned the browser step). */
    cancelMcpAuth: (id: string) => invokeContract("tools:cancelMcpAuth", { id }),

    // OAuth for custom HTTP services (same flow as MCP, no transport).
    startServiceAuth: (id: string) => invokeContract("tools:startServiceAuth", { id }),
    serviceAuthStatus: (id: string) => invokeContract("tools:serviceAuthStatus", { id }),
    signOutService: (id: string) => invokeContract("tools:signOutService", { id }),
    cancelServiceAuth: (id: string) => invokeContract("tools:cancelServiceAuth", { id }),
    /** Fires when a sign-in finishes (loopback listener or cairn://oauth/callback deep link). */
    onOauthCallback: (cb: (e: IpcEvents["tools:oauthCallback"]) => void) => onIpcEvent("tools:oauthCallback", cb),
  },

  // ── Secrets (OS keychain). No get() by design — renderer only learns set/not-set.
  secrets: {
    available: () => invokeContract("secrets:available"),
    set: (toolType: SecretToolType, toolId: string, key: string, value: string) =>
      invokeContract("secrets:set", { toolType, toolId, key, value }),
    has: (toolType: SecretToolType, toolId: string, key: string) =>
      invokeContract("secrets:has", { toolType, toolId, key }),
    delete: (toolType: SecretToolType, toolId: string, key: string) =>
      invokeContract("secrets:delete", { toolType, toolId, key }),
  },

  // ── Community registry (cairn-community catalog) ──────────────
  registry: {
    /** Cache-first: instant/offline, background-revalidates. */
    fetch: () => invokeContract("registry:fetch"),
    /** Force a network refresh (explicit Refresh button). */
    refresh: () => invokeContract("registry:refresh"),
    /** Community AI providers (separate providers.json manifest). Cache-first. */
    fetchProviders: () => invokeContract("registry:fetchProviders"),
    /** Force a network refresh of the providers manifest. */
    refreshProviders: () => invokeContract("registry:refreshProviders"),
    /** Community automation recipes (separate automations.json manifest). Cache-first. */
    fetchAutomations: () => invokeContract("registry:fetchAutomations"),
    /** Force a network refresh of the automations manifest. */
    refreshAutomations: () => invokeContract("registry:refreshAutomations"),
    /** Community personalities (separate personalities.json manifest). Cache-first. */
    fetchPersonalities: () => invokeContract("registry:fetchPersonalities"),
    /** Force a network refresh of the personalities manifest. */
    refreshPersonalities: () => invokeContract("registry:refreshPersonalities"),
    /** Community chat themes (separate themes.json manifest). Cache-first. */
    fetchChatThemes: () => invokeContract("registry:fetchChatThemes"),
    /** Force a network refresh of the chat themes manifest. */
    refreshChatThemes: () => invokeContract("registry:refreshChatThemes"),
  },

  // ── Git operations (Agent Git tab) ────────────
  git: {
    status:   (cwd: string) => invokeContract("git:status", { cwd }),
    branches: (cwd: string) => invokeContract("git:branches", { cwd }),
    checkout: (cwd: string, branch: string, create?: boolean) => invokeContract("git:checkout", { cwd, branch, create }),
    stage:    (cwd: string, opts?: GitPathSelection) => invokeContract("git:stage", { cwd, ...opts }),
    unstage:  (cwd: string, opts?: GitPathSelection) => invokeContract("git:unstage", { cwd, ...opts }),
    commit:   (cwd: string, message: string, body?: string, autoStage?: boolean) => invokeContract("git:commit", { cwd, message, body, autoStage }),
    push:     (cwd: string, setUpstream?: boolean) => invokeContract("git:push", { cwd, setUpstream }),
    log:      (cwd: string, count?: number) => invokeContract("git:log", { cwd, count }),
    diff:     (cwd: string, staged?: boolean) => invokeContract("git:diff", { cwd, staged }),
    diffBranch: (cwd: string, baseBranch: string) => invokeContract("git:diffBranch", { cwd, baseBranch }),
    diffFile: (cwd: string, filePath: string, staged?: boolean) => invokeContract("git:diffFile", { cwd, filePath, staged }),
    stash:    (cwd: string, action: GitStashAction) => invokeContract("git:stash", { cwd, action }),
    createPr: (cwd: string, opts: { title: string; body?: string; base?: string }) => invokeContract("git:createPr", { cwd, ...opts }),
    prStatus: (cwd: string) => invokeContract("git:prStatus", { cwd }),
    discard:  (cwd: string, filePath: string) => invokeContract("git:discard", { cwd, filePath }),
  },

  // ── Cairn native agent (pi) ───────────────────
  session: {
    /** Send a prompt to an existing or new session. Fire-and-forget. */
    prompt: (req: unknown) => ipcRenderer.send("session:prompt", req),
    /** Canonical raw DSH session/event stream shared by Chat and Coding. */
    onEvent: (cb: (e: SessionEventEnvelope) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: Parameters<typeof cb>[0]) => cb(payload);
      ipcRenderer.on("session:event", handler);
      return () => ipcRenderer.off("session:event", handler);
    },
    /** Reasoning-provenance snapshot for the agent panel's Context Ring badge */
    contextRing: (sessionId: string) => invokeContract("session:context-ring", { sessionId }),
    isRunning: (sessionId: string) => invokeContract("session:is-running", { sessionId }),
    /** Bulk snapshot of session ids whose loop is in flight right now. */
    runningIds: () => invokeContract("session:running-ids"),
    /** Abort the current in-flight turn for this session. */
    abort: (sessionId: string) => ipcRenderer.send("session:abort", { sessionId }),
    /** Clear message history for a session (start fresh). */
    clear: (sessionId: string) => ipcRenderer.send("session:clear", { sessionId }),
    /** Destroy a session when the tab is closed. */
    destroy: (sessionId: string) => ipcRenderer.send("session:destroy", { sessionId }),
    /** Trigger immediate LLM-based compaction on demand (/compact command). */
    compactNow: (req: unknown) => ipcRenderer.send("session:compact-now", req),

    onProjection: (cb: (projection: SessionProjection) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, payload: SessionProjection) => cb(payload);
      ipcRenderer.on("session:projection", handler);
      return () => ipcRenderer.off("session:projection", handler);
    },
    /** Latest folded session title (chat-only). Null before first eligible title. */
    title: (threadId: string) => invokeContract("session:title", { threadId }),
    /** Pin a manual title (kind:'user' — stops auto-titling). Chat-only. */
    renameTitle: (threadId: string, title: string) => invokeContract("session:renameTitle", { threadId, title }),
    /** Fired when the agent calls ensure_note in plan mode — carries the PRD note ID */
    /**
     * Fired when the agent produces a plan for user review. Two shapes carry
     * this today:
     *   - dsh-plan-mode's `exit_plan_mode` tool call (planContent is set,
     *     noteId is undefined) — the plan is in the tool call args and dsh's
     *     userQuestions.ask surfaces the review card;
     *   - the legacy PRD-note flow (noteId is set, planContent is undefined)
     *     where the agent calls `ensure_note` while in plan mode.
     * A given session may emit both over its lifetime; the renderer uses
     * whichever fields are populated to update the UI.
     */
    /** Approve the plan — switches session to execute mode and starts implementation */
    approvePlan: (req: unknown) => ipcRenderer.send("session:approve-plan", req),
    /** Fired when the agent calls ask_questions — renderer should render an inline form */
    /** Answer a blocked ask_questions call — the text is fed back to the model as the tool result */
    respondQuestions: (sessionId: string, callId: string, answers: string, nonce?: string) => ipcRenderer.send("session:respond-questions", { sessionId, callId, answers, nonce }),
    /** List all persisted coding sessions for a project (project-scoped history) */
    listSessions:   (projectId: string) => invokeContract("db:session:list", { projectId }),
    /** Persist a new coding session row to SQLite */
    createSession:  (input: CodingSessionCreateInput) => invokeContract("db:session:create", input),
    /** Delete a coding session and all its messages from SQLite */
    deleteSession:  (id: string) => invokeContract("db:session:delete", { id }),
    /** Fetch session transcript from the dsh JSONL log (session-as-truth), SQLite fallback */
    getSessionMessages: (sessionId: string) => invokeContract("db:session:messages", { sessionId }),
    /** Fetch the persisted todo list for a session */
    getTodos:       (sessionId: string) => invokeContract("db:session:todos", { sessionId }),
    /** Restore LLM context for a session (loads history into main-process Map) — fire-and-forget */
    restoreContext: (sessionId: string) => ipcRenderer.send("session:restore-context", { sessionId }),
    /**
     * Dynamically switch a session's mode */
    setMode: (sessionId: string, mode: "plan" | "execute") =>
      ipcRenderer.send("session:set-mode", { sessionId, mode }),
    /** Approve or deny a pending tool call; grant:"command" echoes the exact bash command to standing-allow */
    respondTool: (sessionId: string, callId: string, approved: boolean, grant?: "session" | "command" | "workspace", command?: string, nonce?: string) =>
      ipcRenderer.send("session:respond-tool", { sessionId, callId, approved, grant, command, nonce }),
    /** Continuable-child catalog for a parent session (durable + live activity). Scope defaults to direct children; "descendants" lists the full subtree. */
    listSubagents: (parentSessionId: string, scope?: "children" | "descendants") => invokeContract("subagent:list", { parentSessionId, scope: scope ?? "children" }),
    /** Stop a live continuable child's current turn (fire-and-return; absent targets are a no-op) */
    interruptSubagent: (parentSessionId: string, childId: string) => invokeContract("subagent:interrupt", { parentSessionId, childId }),
    /** Deliver a human message to a continuable child (needs the live parent agent; parent-unavailable otherwise) */
    messageSubagent: (parentSessionId: string, childId: string, text: string) => invokeContract("subagent:message", { parentSessionId, childId, text }),
    /** Kill a dsh background job (jobs dock; owner-unavailable when the owner turn ended) */
    killJob: (jobId: string, sessionId: string) => invokeContract("session:job-kill", { jobId, sessionId }),
    /** Current same-session goal snapshot (null when no goal); live changes arrive via onProjection kind:"goal" */
    goal: (sessionId: string) => invokeContract("session:goal", { sessionId }),
    /** Current permission-preset select ({options, currentValue}); live changes arrive via onProjection kind:"permissions". ok:false while the presets service is unavailable (switcher hides) */
    permissions: (sessionId: string) => invokeContract("session:permissions", { sessionId }),
    setPermissionPreset: (sessionId: string, preset: string) => invokeContract("session:permissions:set", { sessionId, preset }),
    /** Rate an assistant message (thumbs + optional note); preserves a stored note unless replaced */
    feedback: (req: PutMessageFeedbackInput) => invokeContract("session:feedback", req),
    /** Current rating for one message (null when unrated) */
    feedbackGet: (sessionId: string, messageId: string) => invokeContract("session:feedback-get", { sessionId, messageId }),
    /** Active session-local reminders (empty when the schedule overlay is off or none) */
    scheduleList: (sessionId: string) => invokeContract("session:schedule-list", { sessionId }),
    /** Workspace-persistent "Always allow" grants */
    listApprovalGrants: (workspaceId: string) => invokeContract("approval-grants:list", { workspaceId }),
    deleteApprovalGrant: (id: string) => invokeContract("approval-grants:delete", { id }),
    clearApprovalGrants: (workspaceId: string) => invokeContract("approval-grants:clear-workspace", { workspaceId }),

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

  // ── Embeddings (local semantic search + knowledge graph) ────
  embeddings: {
    status: () => invokeContract("embeddings:status"),
    stop: () => invokeContract("embeddings:stop"),
    needsReindex: () => invokeContract("embeddings:needsReindex"),
    projections: (workspaceId: string) => invokeContract("embeddings:projections", { workspaceId }),
    reindex: (workspaceId: string, noteIds?: string[], model?: string) =>
      invokeContract("db:embeddings:reindex", { workspaceId, noteIds, model }),
    search: (workspaceId: string, queryText: string, opts?: {
      queryNoteId?: string;
      k?: number;
      excludeIds?: string[];
      model?: string;
    }) => invokeContract("db:embeddings:search", { workspaceId, queryText, ...opts }),
    recomputeProjections: (workspaceId: string, model?: string) =>
      invokeContract("db:embeddings:recomputeProjections", { workspaceId, model }),
    models: {
      list: () => invokeContract("embeddings:models:list"),
      install: (modelId: string) => invokeContract("embeddings:models:install", { modelId }),
      remove: (modelId: string) => invokeContract("embeddings:models:remove", { modelId }),
      setDefault: (modelId: string) => invokeContract("embeddings:models:setDefault", { modelId }),
      onProgress: (cb: (e: EmbeddingDownloadProgress) => void) => onIpcEvent("embeddings:download-progress", cb),
    },
    getSettings: () => invokeContract("app:getEmbeddingsSettings"),
    saveSettings: (config: { enabled?: boolean; modelId?: string }) => invokeContract("app:saveEmbeddingsSettings", { config }),
  },
  // ── Unified Runtime (local embeddings for semantic search) ───────────
  // LLM inference is user-provided: point a saved provider at Ollama,
  // LM Studio, or any OpenAI-compatible local server.
  runtime: {
    status: () => invokeContract("runtime:status"),
    stop: () => invokeContract("runtime:stop"),
    /** List dsh registry commands (name + description) — palette source. */
    listCommands: () => invokeContract("cordis:listCommands"),
    /** Execute a dsh registry command (/plan, /compact, …) on a session's agent. */
    executeCommand: (req: { sessionId: string; line: string }) => invokeContract("cordis:executeCommand", req),
    /** Assemble the real dsh system prompt (Cordis engine) + breakdown. */
    systemPromptPreview: (req: { cwd?: string; projectName?: string }) =>
      invokeContract("runtime:systemPrompt:preview", req),
    /** The coding agent's plain-string system prompt (board-tracking workflow). */
    codingPromptPreview: (req: { cwd?: string; projectName?: string; taskTitle?: string }) =>
      invokeContract("runtime:codingPrompt:preview", req),
    /** Per-surface tool inventory (chat/coding/automation-dev/mcp + live global tools). */
    toolsInventory: () => invokeContract("runtime:tools:inventory"),
    onProgress: (cb: (e: EmbeddingDownloadProgress) => void) => onIpcEvent("runtime:download-progress", cb),
    embeddings: {
      status: () => invokeContract("runtime:embeddings:status"),
      ensureStarted: () => invokeContract("runtime:embeddings:ensureStarted"),
      models: () => invokeContract("runtime:embeddings:models"),
      install: (modelId: string) => invokeContract("runtime:embeddings:install", { modelId }),
      remove: (modelId: string) => invokeContract("runtime:embeddings:remove", { modelId }),
      setDefault: (modelId: string) => invokeContract("runtime:embeddings:setDefault", { modelId }),
      onProgress: (cb: (e: EmbeddingDownloadProgress) => void) => onIpcEvent("runtime:download-progress", cb),
    },
  },
  // ── Mobile Access ────────────────────────────────
  mobile: {
    status: () => invokeContract("mobile:status"),
    saveSettings: (newSettings: Record<string, unknown>) => invokeContract("mobile:saveSettings", newSettings),
    regeneratePin: () => invokeContract("mobile:regeneratePin"),
    onStatusChanged: (cb: (status: MobileStatus) => void) => onIpcEvent("mobile:status-changed", cb),
  },
  /** UI plugins (dev-gated): pull renderer-side plugin sources + live-change events. */
  plugins: {
    listUi: () => invokeContract("plugins:listUi"),
    onUiChanged: (cb: () => void) => onIpcEvent("plugins:ui-changed", cb),
    /** Settings section: full manifest (enabled + disabled), toggle, open folder. */
    list: () => invokeContract("plugins:list"),
    setEnabled: (id: string, enabled: boolean) => invokeContract("plugins:setEnabled", { id, enabled }),
    openFolder: () => invokeContract("plugins:openFolder"),
    /** Install from a spec (github:owner/repo | owner/repo | local path). Dev-gated. */
    install: (spec: string) => invokeContract("plugins:install", { spec }),
    /** Update an installed plugin by re-running its recorded source spec. Dev-gated. */
    update: (id: string) => invokeContract("plugins:update", { id }),
    uninstall: (id: string) => invokeContract("plugins:uninstall", { id }),
  }
} as const;

contextBridge.exposeInMainWorld("electron", api);

// ── Type export for the renderer ────────────────
// Import this type in the renderer to get full type safety on window.electron
export type ElectronAPI = typeof api;
