/**
 * Cairn — Preload script
 *
 * Exposes a typed `window.electron` API to the renderer via contextBridge.
 * Only whitelisted channels are accessible — the renderer has no access
 * to Node.js or Electron internals directly.
 */

import { contextBridge, ipcRenderer } from "electron";

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
    delete: (id: string) => invoke("db:project:delete", { id }),
  },

  // ── Notes ────────────────────────────────────
  note: {
    list:         (projectId?: string) => invoke("db:note:list", { projectId }),
    create:       (args: unknown) => invoke("db:note:create", args),
    update:       (id: string, patch: unknown) => invoke("db:note:update", { id, patch }),
    delete:       (id: string) => invoke("db:note:delete", { id }),
    moveToFolder: (id: string, folder: string) => invoke("db:note:moveToFolder", { id, folder }),
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
    onToken: (cb: (e: { delta: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { delta: string }) => cb(e);
      ipcRenderer.on("chat:token", handler);
      return () => ipcRenderer.off("chat:token", handler);
    },
    onDone: (cb: (e: { content: string; contextRefs: unknown[]; error?: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { content: string; contextRefs: unknown[]; error?: string }) => cb(e);
      ipcRenderer.on("chat:done", handler);
      return () => ipcRenderer.off("chat:done", handler);
    },
    onToolCall: (cb: (e: { tool: string; label: string; args: Record<string, unknown> }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { tool: string; label: string; args: Record<string, unknown> }) => cb(e);
      ipcRenderer.on("chat:tool-call", handler);
      return () => ipcRenderer.off("chat:tool-call", handler);
    },
    onToolCallDone: (cb: (e: { tool: string; cairnRef?: { type: "note" | "task"; id: string; title: string } }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { tool: string; cairnRef?: { type: "note" | "task"; id: string; title: string } }) => cb(e);
      ipcRenderer.on("chat:tool-call-done", handler);
      return () => ipcRenderer.off("chat:tool-call-done", handler);
    },
    onUsage: (cb: (e: { promptTokens: number; completionTokens: number }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { promptTokens: number; completionTokens: number }) => cb(e);
      ipcRenderer.on("chat:usage", handler);
      return () => ipcRenderer.off("chat:usage", handler);
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
    generatePrd: (args: unknown) => invoke<{ id: string; title: string; projectId: string } | { error: string }>("ai:generatePrd", args),
    localLLMStatus: () => invoke<{ available: boolean; reason?: string }>("ai:localLLMStatus"),
  },

  // ── App paths ─────────────────────────────────
  mcpServerPath: () => invoke<string>("app:mcpServerPath"),
  latestChangelog: () => invoke<string | null>("app:latestChangelog"),

  // ── Reveal note in Finder / Explorer ─────────
  revealNote: (noteId: string, projectId: string) => invoke("app:revealNote", { noteId, projectId }),

  // ── Export note as PDF ────────────────────────
  exportNotePdf: (title: string, html: string, options?: { returnBuffer?: boolean }) =>
    invoke<{ filePath?: string; pdfBase64?: string } | null>("app:exportNotePdf", { title, html, options }),

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
  initWorkspace: (workspacePath: string) => invoke<{ requiresRestart: boolean }>("app:initWorkspace", { workspacePath }),
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
    onUsage: (cb: (e: { sessionId: string; promptTokens: number; completionTokens: number }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; promptTokens: number; completionTokens: number }) => cb(e);
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
