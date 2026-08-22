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
// ── User writing style (persona + full guide + cheat sheet) ──────────────────
interface UserStylePersona {
  name?: string; role?: string; context?: string; audiences?: string;
}
interface UserStyleRow {
  id: string; persona: UserStylePersona | null;
  fullGuide: string; cheatsheet: string;
  source: "none" | "guided" | "manual" | "analyzed"; updatedAt: string;
}
interface UserStyleSaveInput {
  persona?: UserStylePersona; fullGuide?: string; cheatsheet?: string;
  source: "none" | "guided" | "manual" | "analyzed";
}
interface UserStyleGenerationInput {
  persona: UserStylePersona;
  samples: Array<{ context: string; text: string }>;
  answers: Array<{ question: string; answer: string }>;
  fullGuide?: string;
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
// Canonical, Zod-validated definitions live in shared/chat/registry-schema.ts.
// These interfaces are hand-mirrored here (like the MCP/service/command ones
// above) because preload is a separate esbuild target that can't import the
// shared module's runtime; keep them in sync with the shared source.
interface RegistryProviderEntry extends RegistryEntryMeta {
  definition: {
    name: string; baseUrl: string; defaultModel?: string; needsApiKey: boolean;
    apiKeyUrl?: string; models?: string[];
  };
}
interface ProvidersManifest {
  version: number; updatedAt: string; providers: RegistryProviderEntry[];
}
interface ProvidersFetchResult {
  manifest: ProvidersManifest; fromCache: boolean; cachedAt?: string; error?: string;
}
interface RegistryAutomationEntry extends RegistryEntryMeta {
  definition: {
    name: string; description?: string; instructions: string;
    schedule: { kind: "cron" | "every" | "once"; expr: string; timezone?: string };
    approvalMode?: "auto" | "ask"; maxRuns?: number;
  };
}
interface AutomationsManifest {
  version: number; updatedAt: string; automations: RegistryAutomationEntry[];
}
interface AutomationsFetchResult {
  manifest: AutomationsManifest; fromCache: boolean; cachedAt?: string; error?: string;
}
interface RegistryPersonalityEntry extends RegistryEntryMeta {
  definition: { name: string; description?: string; prompt: string };
}
interface PersonalitiesManifest {
  version: number; updatedAt: string; personalities: RegistryPersonalityEntry[];
}
interface PersonalitiesFetchResult {
  manifest: PersonalitiesManifest; fromCache: boolean; cachedAt?: string; error?: string;
}
interface RegistryThemeMode {
  bg: string; stops: string[]; userBubble: string; userBubbleFg: string;
  aiBubble: string; aiText: string;
}
interface RegistryThemeEntry extends RegistryEntryMeta {
  definition: {
    name: string; description?: string; font: "sans" | "serif" | "mono";
    fontWeight: "regular" | "medium"; tracking: number; lineHeight: number;
    bgType: "solid" | "gradient" | "pattern";
    pattern: "none" | "scanlines" | "dots" | "grid" | "crosshatch" | "diagonal" | "noise";
    bubbleStyle: "filled" | "glass" | "outlined";
    radius: "sm" | "md" | "pill"; shadow: "none" | "subtle" | "strong";
    dark: RegistryThemeMode; light: RegistryThemeMode;
  };
}
interface ChatThemesManifest {
  version: number; updatedAt: string; themes: RegistryThemeEntry[];
}
interface ChatThemesFetchResult {
  manifest: ChatThemesManifest; fromCache: boolean; cachedAt?: string; error?: string;
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

// ── Inline types for the Usage view (usage:overview / usage:recent) ──────────
type UsageSource =
  | "chat" | "pi-agent" | "chat-subagent" | "pi-subagent" | "automation"
  | "prd" | "commit-message" | "pr-description" | "explain" | "flow-ai-summary"
  | "summary" | "tool-builder";
interface UsageTotals {
  promptTokens: number; completionTokens: number; reasoningTokens: number;
  cacheReadTokens: number; costUsd: number; requests: number;
}
interface UsageOverviewData {
  totals: UsageTotals;
  previous: UsageTotals | null;
  series: Array<UsageTotals & { day: string }>;
  bySource: Array<UsageTotals & { source: UsageSource }>;
  byModel: Array<UsageTotals & { model: string }>;
}
interface UsageRecentRow {
  id: string; workspaceId: string | null; projectId: string | null; source: UsageSource;
  sessionId: string | null; provider: string | null; model: string; baseUrl: string | null;
  promptTokens: number; completionTokens: number; reasoningTokens: number;
  cacheReadTokens: number; cacheCreationTokens: number;
  costUsd: number | null; costEstimated: boolean; finishReason: string | null; createdAt: number;
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

  // ── Heartbeat automations ─────────────────────
  automation: {
    list:   (workspaceId: string) => invoke("db:automation:list", { workspaceId }),
    get:    (id: string) => invoke("db:automation:get", { id }),
    create: (args: unknown) => invoke("db:automation:create", args),
    update: (id: string, patch: unknown) => invoke("db:automation:update", { id, patch }),
    delete: (id: string) => invoke("db:automation:delete", { id }),
    runs:   (automationId: string, limit?: number) => invoke("db:automation:runs", { automationId, limit }),
    recentRuns: (workspaceId: string, projectId?: string | null, limit?: number) => invoke("db:automation:recentRuns", { workspaceId, projectId: projectId ?? null, limit }),
    runNow: (id: string) => invoke("db:automation:runNow", { id }),
    runningCount: () => invoke("db:automation:runningCount"),
    /** Approve/deny a pending tool approval for a running automation (Cordis). */
    approve: (callId: string, approved: boolean, grant?: "session" | "always") => invoke("automation:approve", { callId, approved, grant }),
    folder: (id: string) => invoke<{ folder: string }>("db:automation:folder", { id }),
    syncFromManifest: (id: string) => invoke("db:automation:syncFromManifest", { id }),
    files: (id: string) => invoke<{ files: Array<{ path: string; size: number; mtimeMs: number }> }>("db:automation:files", { id }),
    runLog: (runId: string) => invoke<{ log: unknown } | { error: string }>("db:automation:runLog", { runId }),
    /** Live run activity (tokens/tools/thought) for the "watch this run" view. */
    onRunEvent: (cb: (payload: {
      event: "started" | "token" | "thought" | "tool" | "toolDone" | "toolConfirmRequired" | "approval" | "finished";
      automationId: string;
      runId: string;
      delta?: string;
      tool?: string;
      label?: string;
      args?: Record<string, unknown>;
      status?: "start" | "end";
      ok?: boolean;
      output?: string;
      error?: string;
      recipe?: string;
      content?: string;
      exhausted?: boolean;
      callId?: string;
    }) => void) => {
      const handler = (_e: unknown, payload: Parameters<typeof cb>[0]) => cb(payload);
      ipcRenderer.on("automation:run", handler);
      return () => { ipcRenderer.removeListener("automation:run", handler); };
    },
    env: {
      get: (automationId: string) => invoke<Array<{ name: string; secret: boolean; value?: string; set?: boolean }> | { error: string }>("db:automation:env", { automationId }),
      set: (automationId: string, name: string, value: string, secret: boolean) => invoke<Array<{ name: string; secret: boolean; value?: string; set?: boolean }> | { error: string }>("db:automation:env:set", { automationId, name, value, secret }),
      delete: (automationId: string, name: string) => invoke<Array<{ name: string; secret: boolean; value?: string; set?: boolean }> | { error: string }>("db:automation:env:delete", { automationId, name }),
    },
    /** Installed/attached status per required connector (New Automation browse guard). */
    checkRequirements: (workspaceId: string, projectId: string, requires: Array<{ kind: "mcp" | "service"; name: string }>) =>
      invoke<Array<{ kind: "mcp" | "service"; name: string; installed: boolean; attached: boolean }>>("db:automation:checkRequirements", { workspaceId, projectId, requires }),
    preview: (scheduleKind: string, scheduleExpr: string, timezone?: string | null) => invoke("db:automation:preview", { scheduleKind, scheduleExpr, timezone }),
  },

  // ── Approval inbox ────────────────────────────
  approval: {
    listPending: (limit?: number) => invoke("db:approval:listPending", { limit }),
    resolve: (id: string, resolution: "approved_once" | "approved_session" | "approved_always" | "denied") => invoke("db:approval:resolve", { id, resolution }),
    count: () => invoke("db:approval:count"),
  },

  // ── Chat ─────────────────────────────────────
  chat: {
    threads:       (workspaceId: string) => invoke("db:chat:threads", { workspaceId }),
    sessionMessages: (threadId: string) => invoke("db:chat:sessionMessages", { threadId }),
    upsertThread:  (args: unknown) => invoke("db:chat:upsertThread", args),
    deleteThread:  (threadId: string) => invoke("db:chat:deleteThread", { threadId }),
    clearThreadMessages: (threadId: string) => invoke("db:chat:clearThreadMessages", { threadId }),
    clearAllThreads: (workspaceId: string, projectId?: string) => invoke("db:chat:clearAllThreads", { workspaceId, projectId }),
    compactThread: (req: unknown) => invoke("chat:compactThread", req),
    // ── AI Chat streaming ──────────────────────
    // Fire-and-forget. Listen with onToken / onDone / onToolCall.
    stream: (req: unknown) => ipcRenderer.send("chat:stream", req),
    abort: () => ipcRenderer.send("chat:abort"),
    answerQuestions: (req: { requestId: string; answers: string }) => ipcRenderer.send("chat:answer-questions", req),
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
    onDone: (cb: (e: { content: string; reasoning?: string; reasoningSummary?: string; reasoningItems?: Array<Record<string, unknown>>; reasoningField?: string; reasoningModel?: string; contextRefs: unknown[]; error?: string; threadId?: string; usage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number; breakdown?: unknown; costUsd?: number; cacheReadTokens?: number; cacheCreationTokens?: number } }) => void) => {
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
    onToolCallDone: (cb: (e: { tool: string; cairnRef?: { type: "note" | "task"; id: string; title: string }; externalRef?: { url: string; title?: string; snippet?: string }; output?: string; callId?: string; threadId?: string; ok?: boolean; error?: string; meta?: unknown }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { tool: string; cairnRef?: { type: "note" | "task"; id: string; title: string }; externalRef?: { url: string; title?: string; snippet?: string }; output?: string; callId?: string; threadId?: string; ok?: boolean; error?: string }) => cb(e);
      ipcRenderer.on("chat:tool-call-done", handler);
      return () => ipcRenderer.off("chat:tool-call-done", handler);
    },
    onUsage: (cb: (e: { promptTokens: number; completionTokens: number; reasoningTokens?: number; breakdown?: unknown; costUsd?: number; cacheReadTokens?: number; cacheCreationTokens?: number; threadId?: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { promptTokens: number; completionTokens: number; reasoningTokens?: number; breakdown?: unknown; costUsd?: number; cacheReadTokens?: number; cacheCreationTokens?: number; threadId?: string }) => cb(e);
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
    onSubagentUsage: (cb: (e: { childId: string; promptTokens: number; completionTokens: number; reasoningTokens?: number; costUsd?: number; cacheReadTokens?: number; cacheCreationTokens?: number; breakdown?: unknown; threadId?: string }) => void) => {
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
        currency: "USD" | "CNY";
      } | null>("ai:fetchKeyInfo", args),
  },

  // ── Usage statistics (LLM/agent usage log) ─────
  usage: {
    overview: (args: { workspaceId?: string; source?: UsageSource; from?: number; to?: number; excludeEstimated?: boolean }) =>
      invoke<UsageOverviewData>("usage:overview", args),
    recent: (args: { workspaceId?: string; source?: UsageSource; from?: number; to?: number; limit?: number; excludeEstimated?: boolean }) =>
      invoke<UsageRecentRow[]>("usage:recent", args),
    /** Destructive — delete recorded usage rows scoped to the workspace filter. */
    clear: (args: { workspaceId?: string }) =>
      invoke<{ deleted: number; ok: boolean }>("usage:clear", args),
    /** Push the models.dev per-1M pricing map (used for cost estimation). */
    setPricing: (map: Record<string, { input: number | null; output: number | null; cacheRead?: number | null; cacheWrite?: number | null }>) =>
      invoke<{ ok: boolean }>("app:modelPricing", map),
    /** Push model ids that declare they don't support temperature control. */
    setNoTemperatureModels: (ids: string[]) =>
      invoke<{ ok: boolean }>("app:noTemperatureModels", ids),
  },

  // ── App paths ─────────────────────────────────
  mcpServerPath: () => invoke<string>("app:mcpServerPath"),
  latestChangelog: () => invoke<string | null>("app:latestChangelog"),

  // ── Reveal note in Finder / Explorer ─────────
  revealNote: (noteId: string, projectId: string) => invoke("app:revealNote", { noteId, projectId }),

  // ── Export note as PDF ────────────────────────
  exportNotePdf: (title: string, html: string, options?: { returnBuffer?: boolean; theme?: "light" | "dark"; fontFamily?: string }) =>
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
  initWorkspace: (workspacePath: string, excludedFolders?: string[]) => invoke<{ ok: true }>("app:initWorkspace", { workspacePath, excludedFolders }),
  rescanWorkspace: (workspaceId?: string, excludedFolders?: string[]) => invoke<{ projectsCreated: number; createdProjects: { id: string; name: string; noteCount: number }[] }>("app:rescanWorkspace", { workspaceId, excludedFolders }),
  rollbackImport: (projectIds: string[]) => invoke<{ removedNotes: number; ok: boolean }>("app:rollbackImport", { projectIds }),
  probeWorkspaceFolder: (folder: string) => invoke<{ isObsidianVault: boolean; vaultName: string; noteCount: number; skippedCount: number; projects: { name: string; noteCount: number; root: boolean; projectKey: string }[]; excludedFolders: string[] }>("app:probeWorkspaceFolder", { folder }),
  relaunch: () => invoke("app:relaunch"),
  resetAllData: () => invoke("app:reset"),
  getAiSettings: () => invoke<Record<string, unknown> | null>("app:getAiSettings"),
  saveAiSettings: (config: Record<string, unknown>) => invoke<{ ok: true }>("app:saveAiSettings", { config }),
  // User writing style (persona + full guide + cheat sheet) — Settings → Writing Style.
  getUserStyle: () => invoke<UserStyleRow | null>("user-style:get"),
  saveUserStyle: (input: UserStyleSaveInput) => invoke<UserStyleRow>("user-style:save", { input }),
  clearUserStyle: () => invoke<{ ok: true }>("user-style:clear"),
  generateUserStyle: (step: "full" | "cheatsheet" | "optimize", input: UserStyleGenerationInput) =>
    invoke<{ markdown: string }>("user-style:generate", { step, input }),
  // Streaming generation (wizard) — fire-and-forget; listen via onUserStyle*.
  // Credentials are resolved main-side (resolveChatConfig), never sent here.
  generateUserStyleStream: (req: {
    workspaceId?: string;
    projectId?: string;
    projectName?: string;
    step: "full" | "cheatsheet" | "optimize";
    analyseNotes: boolean;
    input: UserStyleGenerationInput;
  }) => ipcRenderer.send("user-style:generateStream", req),
  abortUserStyleStream: () => ipcRenderer.send("user-style:abort"),
  onUserStyleToken: (cb: (e: { delta: string }) => void) => {
    const handler = (_: unknown, e: { delta: string }) => cb(e);
    ipcRenderer.on("user-style:token", handler);
    return () => ipcRenderer.off("user-style:token", handler);
  },
  onUserStyleToolCall: (cb: (e: { tool: string; label: string; args: Record<string, unknown> }) => void) => {
    const handler = (_: unknown, e: { tool: string; label: string; args: Record<string, unknown> }) => cb(e);
    ipcRenderer.on("user-style:tool-call", handler);
    return () => ipcRenderer.off("user-style:tool-call", handler);
  },
  onUserStyleToolCallDone: (cb: (e: { tool: string; ok?: boolean; error?: string }) => void) => {
    const handler = (_: unknown, e: { tool: string; ok?: boolean; error?: string }) => cb(e);
    ipcRenderer.on("user-style:tool-call-done", handler);
    return () => ipcRenderer.off("user-style:tool-call-done", handler);
  },
  onUserStyleDone: (cb: (e: { content: string; usable: boolean; error?: string }) => void) => {
    const handler = (_: unknown, e: { content: string; usable: boolean; error?: string }) => cb(e);
    ipcRenderer.on("user-style:done", handler);
    return () => ipcRenderer.off("user-style:done", handler);
  },
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
    // Recent reconcile decisions — why a row was applied, skipped or deleted.
    activity: (limit?: number) =>
      invoke<Array<{
        seq: number;
        at: string;
        entity: string;
        entity_id: string;
        op: "put" | "delete";
        hlc: string;
        origin: string;
        outcome: "applied" | "conflict-copy" | "delete-won" | "skipped-stale";
        conflict_copy_id: string | null;
        title: string | null;
        isSelf: boolean;
        conflict_side: "local" | "remote" | null;
      }>>("sync:activity", { limit }),
    // Notes deleted by another device that can still be restored. `total` may
    // exceed `rows.length` — never present the page size as the count.
    listRestorable: (limit?: number) =>
      invoke<{
        rows: Array<{
          entity: string;
          entity_id: string;
          title: string | null;
          deleted_at: string | null;
          delete_origin: string | null;
        }>;
        total: number;
      }>("sync:listRestorable", { limit }),
    restoreNote: (id: string) =>
      invoke<{ restored: boolean; reason?: string; fileError?: string }>("sync:restoreNote", { id }),
    // Retry the .md write for a restore whose DB half already succeeded.
    repairNoteFile: (id: string) =>
      invoke<{ repaired: boolean; reason?: string; fileError?: string }>("sync:repairNoteFile", { id }),
    // Peer devices on a different sync protocol version (behind = too old to honour deletes).
    peerProtocols: () =>
      invoke<Array<{ deviceId: string; version: number; behind: boolean }>>("sync:peerProtocols"),
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

  // ── In-app notification center ─────────────────
  notification: {
    list: (limit?: number) => invoke("db:notification:list", { limit }),
    count: () => invoke("db:notification:count"),
    markRead: (id: string) => invoke("db:notification:markRead", { id }),
    markAllRead: () => invoke("mcp:markNotificationsRead"),
    clear: () => invoke("db:notification:clear"),
  },

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
    /** Community AI providers (separate providers.json manifest). Cache-first. */
    fetchProviders: () => invoke<ProvidersFetchResult>("registry:fetchProviders"),
    /** Force a network refresh of the providers manifest. */
    refreshProviders: () => invoke<ProvidersFetchResult>("registry:refreshProviders"),
    /** Community automation recipes (separate automations.json manifest). Cache-first. */
    fetchAutomations: () => invoke<AutomationsFetchResult>("registry:fetchAutomations"),
    /** Force a network refresh of the automations manifest. */
    refreshAutomations: () => invoke<AutomationsFetchResult>("registry:refreshAutomations"),
    /** Community personalities (separate personalities.json manifest). Cache-first. */
    fetchPersonalities: () => invoke<PersonalitiesFetchResult>("registry:fetchPersonalities"),
    /** Force a network refresh of the personalities manifest. */
    refreshPersonalities: () => invoke<PersonalitiesFetchResult>("registry:refreshPersonalities"),
    /** Community chat themes (separate themes.json manifest). Cache-first. */
    fetchChatThemes: () => invoke<ChatThemesFetchResult>("registry:fetchChatThemes"),
    /** Force a network refresh of the chat themes manifest. */
    refreshChatThemes: () => invoke<ChatThemesFetchResult>("registry:refreshChatThemes"),
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
    /** Whether a runAgentLoop is currently in flight for this session. */
    isRunning: (sessionId: string) => invoke<{ running: boolean; pendingAsks: Array<{ sessionId: string; name: string; label: string; callId: string }> }>("pi-agent:is-running", { sessionId }),
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
    onTool: (cb: (e: { sessionId: string; name: string; label: string; args?: Record<string, unknown>; callId?: string; status: "pending" | "start" | "end"; ok?: boolean; output?: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; name: string; label: string; args?: Record<string, unknown>; callId?: string; status: "pending" | "start" | "end"; ok?: boolean; output?: string }) => cb(e);
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
    onUsage: (cb: (e: { sessionId: string; promptTokens: number; completionTokens: number; reasoningTokens?: number; breakdown?: unknown; cacheReadTokens?: number; cacheCreationTokens?: number }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; promptTokens: number; completionTokens: number; reasoningTokens?: number; breakdown?: unknown; cacheReadTokens?: number; cacheCreationTokens?: number }) => cb(e);
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
    /** Fired after the todowrite tool persists a new list — live todo-dock updates */
    onTodos: (cb: (e: { sessionId: string; todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" | "cancelled"; priority: "high" | "medium" | "low" }> }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" | "cancelled"; priority: "high" | "medium" | "low" }> }) => cb(e);
      ipcRenderer.on("pi-agent:todos", handler);
      return () => ipcRenderer.off("pi-agent:todos", handler);
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
    onAskQuestions: (cb: (e: { sessionId: string; callId: string; questions: Array<{ id: string; label: string; prompt: string }> }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; callId: string; questions: Array<{ id: string; label: string; prompt: string }> }) => cb(e);
      ipcRenderer.on("pi-agent:ask-questions", handler);
      return () => ipcRenderer.off("pi-agent:ask-questions", handler);
    },
    /** Answer a blocked ask_questions call — the text is fed back to the model as the tool result */
    respondQuestions: (sessionId: string, callId: string, answers: string) => ipcRenderer.send("pi-agent:respond-questions", { sessionId, callId, answers }),
    /** List all persisted pi sessions for a project (project-scoped history) */
    listSessions:   (projectId: string) => invoke("db:piSession:list", { projectId }),
    /** Persist a new pi session row to SQLite */
    createSession:  (args: unknown) => invoke("db:piSession:create", args),
    /** Delete a pi session and all its messages from SQLite */
    deleteSession:  (id: string) => invoke("db:piSession:delete", { id }),
    /** Fetch session transcript from the dsh JSONL log (session-as-truth), SQLite fallback */
    getSessionMessages: (sessionId: string) => invoke("db:piSession:sessionMessages", { sessionId }),
    /** Fetch the persisted todo list for a session */
    getTodos:       (sessionId: string) => invoke<Array<{ content: string; status: "pending" | "in_progress" | "completed" | "cancelled"; priority: "high" | "medium" | "low" }>>("db:piSession:todos", { sessionId }),
    /** Restore LLM context for a session (loads history into main-process Map) — fire-and-forget */
    restoreContext: (sessionId: string) => ipcRenderer.send("pi-agent:restore-context", { sessionId }),
    /**
     * Dynamically switch a session's mode */
    setMode: (sessionId: string, mode: "plan" | "execute") =>
      ipcRenderer.send("pi-agent:set-mode", { sessionId, mode }),
    /** Approve or deny a pending tool call; grant:"command" echoes the exact bash command to standing-allow */
    respondTool: (sessionId: string, callId: string, approved: boolean, grant?: "session" | "command", command?: string) =>
      ipcRenderer.send("pi-agent:respond-tool", { sessionId, callId, approved, grant, command }),
    /** Listen for tool call confirmation requests */
    onToolConfirmRequired: (cb: (e: { sessionId: string; callId: string; name: string; label: string; args?: Record<string, unknown> }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; callId: string; name: string; label: string; args?: Record<string, unknown> }) => cb(e);
      ipcRenderer.on("pi-agent:tool-confirm-required", handler);
      return () => ipcRenderer.off("pi-agent:tool-confirm-required", handler);
    },
    /** A pending confirmation expired unanswered — the loop settled it fail-closed. */
    onToolConfirmExpired: (cb: (e: { sessionId: string; callId: string }) => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (_: any, e: { sessionId: string; callId: string }) => cb(e);
      ipcRenderer.on("pi-agent:tool-confirm-expired", handler);
      return () => ipcRenderer.off("pi-agent:tool-confirm-expired", handler);
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
    /** List dsh registry commands (name + description) — palette source. */
    listCommands: () => invoke<Array<{ name: string; description: string }>>("cordis:listCommands"),
    /** Execute a dsh registry command (/plan, /compact, …) on a session's agent. */
    executeCommand: (req: { sessionId: string; line: string }) => invoke<{ kind?: string; text?: string }>(
      "cordis:executeCommand", req
    ),
    /** Assemble the real dsh system prompt (Cordis engine) + breakdown. */
    systemPromptPreview: (req: { cwd?: string }) => invoke<{
      text: string;
      sections: Array<{ name: string; order: number; text: string; index: number }>;
      contexts: Array<{ name: string; order: number; text: string }>;
      skills: Array<{ name: string; description: string }>;
      tools: Array<{ name: string; description?: string }>;
      variables: Record<string, string | undefined>;
      error?: string;
    }>("runtime:systemPrompt:preview", req),
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
  },
  /** UI plugins (dev-gated): pull renderer-side plugin sources + live-change events. */
  plugins: {
    listUi: () => invoke<Array<{ id: string; source: string }>>("plugins:listUi"),
    onUiChanged: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on("plugins:ui-changed", handler);
      return () => ipcRenderer.off("plugins:ui-changed", handler);
    },
    /** Settings section: full manifest (enabled + disabled), toggle, open folder. */
    list: () => invoke<{
      devEnabled: boolean;
      root: string;
      plugins: Array<{ id: string; kind: "ui" | "backend" | "both"; name: string | null; ui: string | null; disabled: boolean }>;
    }>("plugins:list"),
    setEnabled: (id: string, enabled: boolean) => invoke<{ ok: boolean }>("plugins:setEnabled", { id, enabled }),
    openFolder: () => invoke<{ ok: boolean }>("plugins:openFolder"),
    /** Install from a spec (github:owner/repo | owner/repo | local path). Dev-gated. */
    install: (spec: string) =>
      invoke<{ id: string; name: string | null; ui: string | null; kind: "ui" | "backend" | "both" }>("plugins:install", { spec }),
    uninstall: (id: string) => invoke<{ ok: boolean }>("plugins:uninstall", { id }),
  }
} as const;

contextBridge.exposeInMainWorld("electron", api);

// ── Type export for the renderer ────────────────
// Import this type in the renderer to get full type safety on window.electron
export type ElectronAPI = typeof api;
