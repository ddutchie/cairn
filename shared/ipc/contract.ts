/**
 * Typed IPC contract between the Electron main process and preload.
 *
 * Each invoke channel lists its argument tuple and its result (the `data` of
 * the `{ data } | { error }` envelope that `handle()` wraps it in). Main
 * registers handlers with `registerContractHandle` and preload calls them
 * with `invokeContract`, so a typo'd channel or a changed payload on either
 * side fails the build. Channels migrate here one domain at a time; the rest
 * still use the untyped `registerIpcHandle` / `invoke`.
 *
 * Preload passes at most one argument per call, so `args` is `[]` or `[x]`.
 *
 * The types describe what a well-behaved renderer sends. Renderer content is
 * untrusted, so handlers must still validate arguments at runtime (e.g.
 * `bindChatPopoutSession` for chat:popOut) — the contract is not a guard.
 */

import type { ChatPopoutPayload } from "../agent/chat-popout";
import type {
  AgentSessionMessage, CodingSessionCreateInput, CodingSessionRow, ContextRingResult, ControlResult, GoalWire,
  MessageFeedbackItemWire, PermissionsSelect, PutMessageFeedbackInput, ScheduleWire, SessionLoadExtras,
  SessionRunningState, SessionTodo, SubagentCatalogView, SubagentScope,
} from "../agent/session-wire";
import type { ChatMessage, ChatThread, ChatThreadUpsertInput } from "../types/chat";
import type {
  GitBranchList, GitFileDiff, GitLogEntry, GitPathSelection, GitPrStatus, GitStashAction, GitStatus,
} from "../types/git";
import type {
  Automation, AutomationEnvSpec, AutomationFolderFile, AutomationInput, AutomationPatch, AutomationRequirement,
  AutomationRun, AutomationRunEvent, AutomationRunWithAutomation, RequirementStatus, RunLog,
} from "../types/automations";
import type {
  BoardColumn, CardCreateInput, CardPatch, ColumnCreateInput, ColumnPatch, TaskCard,
} from "../types/board";
import type {
  FlowAiConfig, FlowEdgeCreateInput, FlowNodeCreateInput, FlowNodePatch, IdeaFlowEdge, IdeaFlowNode,
  ResolvedIdeaFlow, UrlMetadata,
} from "../types/flow";
import type {
  Project, ProjectCreateInput, ProjectMergeResult, ProjectPatch, ProjectSettings, Tag, TagCreateInput, TagPatch,
  Workspace, WorkspaceCreateInput, WorkspacePatch,
} from "../types/workspace";
import type { Note, NoteBody, NoteCreateInput, NotePatch } from "../types/notes";
import type { McpNotification } from "../types/notifications";
import type {
  AiEndpoint, AiRequestConfig, LlmLeftovers, MigrationProgress, MigrationStatus, ModelPrice, PrdResult,
  UpdateAvailableInfo, VaultImportPreview, WorkspaceRescanResult,
} from "../types/app";
import type { CreditInfo } from "../chat/provider-credits";
import type {
  CodebaseGraph, CodebaseModuleGraph, CodebaseOverview, CodebaseRelations, CodebaseSymbol,
} from "../types/codebase";
import type {
  AgentSpawnInput, CodingAgent, CodingAgentInput, DirEntry, FileSearchResult, ModelPtyEvent, ModelTerminal,
  PtyDataEvent, PtyExitEvent,
} from "../types/coding-agent";
import type { PdfTheme } from "../notes/pdf-template";
import type {
  AuthCompleteResult, AuthStartResult, CustomServiceConfig, ListMcpToolsResult, McpServerConfig, McpTestResult,
  SecretToolType, ServiceTestResult, ToolAttachment,
} from "../types/tools";
import type { ChangeSet, EntitySnapshot } from "../types/snapshot";
import type { GraphQueryFilters, KnowledgeGraph, NeighboursResult } from "../types/graph";
import type { GraphEdgeType } from "../types/domain";
import type { CustomSlashCommand, SlashCommandCreateInput, SlashCommandPatch } from "../types/workspace";
import type { UsageOverview, UsageRangeArgs, UsageRecentRow, UsageThreadGroup } from "../types/usage";
import type {
  UserStyleDoneEvent, UserStyleGenerationInput, UserStyleRow, UserStyleSaveInput, UserStyleStep,
  UserStyleToolCallDoneEvent, UserStyleToolCallEvent,
} from "../types/user-style";
import type { ApprovalGrant } from "../types/approval";
import type {
  ConflictCopy, ConflictResolution, DesktopSyncResult, PeerProtocol, RestorableRow, SyncActivityRow,
  SyncPendingBreakdown, SyncStatus,
} from "../types/sync";
import type {
  AutomationsFetchResult, ChatThemesFetchResult, PersonalitiesFetchResult, ProvidersFetchResult, RegistryFetchResult,
} from "../chat/registry-schema";
import type { InstalledPlugin, PluginList, UiPluginSource } from "../types/plugins";
import type {
  AdjacentNote, EmbeddingDownloadProgress, EmbeddingModelManifestEntry, EmbeddingsStatus, NoteProjectionRow,
  ProjectionResult, ReindexResult, RuntimeEmbeddingModel, RuntimeStatus,
} from "../types/embeddings";
import type { MobileStatus, SystemPromptPreview, ToolInventory } from "../types/runtime";

/** Why a pop-out handshake call was refused. */
export type PopoutRefusal = "invalid-payload" | "profile-mismatch" | "not-main-window" | "not-popout";

/** Acknowledgement returned by the pop-out handshake channels. */
export interface PopoutAck {
  ok: boolean;
  reason?: PopoutRefusal;
}

export interface IpcContract {
  // ── Chat pop-out window ──────────────────────────────────────────────────
  /** Main window → open (or refocus) the pop-out for this session. */
  "chat:popOut": { args: [payload: ChatPopoutPayload]; result: PopoutAck };
  /** Pop-out page → ready; returns the session it should show. */
  "chat:popoutReady": {
    args: [];
    result: ChatPopoutPayload & { reason?: "not-popout" | "profile-mismatch" };
  };
  /** Main window → ask the pop-out to return. */
  "chat:requestPopIn": { args: []; result: PopoutAck };
  /** Pop-out page → close and hand the session back to the main window. */
  "chat:popIn": { args: [payload: { sessionId: string }]; result: PopoutAck };

  // ── Chat threads ─────────────────────────────────────────────────────────
  "db:chat:threads": { args: [req: { workspaceId: string }]; result: ChatThread[] };
  /** Transcript from the thread's dsh session log; empty for a thread with no log yet. */
  "db:chat:sessionMessages": {
    args: [req: { threadId: string }];
    result: SessionLoadExtras & { messages: ChatMessage[]; title?: string | null };
  };
  "db:chat:upsertThread": { args: [input: ChatThreadUpsertInput]; result: ChatThread };
  "db:chat:deleteThread": { args: [req: { threadId: string }]; result: void };
  /** Wipes the thread's session logs (incl. subagent children) and cached agent. */
  "db:chat:clearThreadMessages": { args: [req: { threadId: string }]; result: void };
  "db:chat:clearAllThreads": {
    args: [req: { workspaceId: string; projectId?: string | null }];
    result: { deletedThreads: number; deletedMessages: number };
  };
  /** Compact the thread's session log (summary node + retained tail). */
  "chat:compactThread": {
    args: [req: {
      messages: Array<{ role: string; content: string }>;
      threadId: string;
      config: { provider?: string; baseUrl?: string; model?: string; apiKey?: string; apiMode?: "responses" | "completions" | "anthropic-messages" };
    }];
    result: { compacted: boolean };
  };

  /** One-shot markdown summary of the given messages (archive-to-note); doesn't touch the session log. */
  "chat:summarizeTranscript": {
    args: [req: {
      messages: Array<{ role: string; content: string }>;
      config: { provider?: string; baseUrl?: string; model?: string; apiKey?: string; apiMode?: "responses" | "completions" | "anthropic-messages" };
      projectId?: string;
      workspaceId?: string;
    }];
    result: { summary: string };
  };

  // ── Coding sessions ──────────────────────────────────────────────────────
  "db:session:list": { args: [req: { projectId: string }]; result: CodingSessionRow[] };
  "db:session:create": { args: [input: CodingSessionCreateInput]; result: CodingSessionRow };
  "db:session:delete": { args: [req: { id: string }]; result: void };
  "db:session:todos": { args: [req: { sessionId: string }]; result: SessionTodo[] };
  /** Transcript from the session's dsh log; rejects on corrupt/unsupported logs, empty when missing. */
  "db:session:messages": {
    args: [req: { sessionId: string }];
    result: SessionLoadExtras & { messages: AgentSessionMessage[] };
  };
  "session:is-running": { args: [req: { sessionId: string }]; result: SessionRunningState };
  "session:running-ids": { args: []; result: { ids: string[] } };
  "session:context-ring": { args: [req: { sessionId: string }]; result: ContextRingResult };
  /** Chat-only; null before the first eligible title. */
  "session:title": { args: [req: { threadId?: string; sessionId?: string }]; result: { title: string | null } };
  /** Pins a manual title (stops auto-titling). Chat-only. */
  "session:renameTitle": {
    args: [req: { threadId?: string; sessionId?: string; title: string }];
    result: { title: string };
  };
  "session:permissions": { args: [req: { sessionId: string }]; result: ControlResult<PermissionsSelect> };
  "session:permissions:set": { args: [req: { sessionId: string; preset: string }]; result: ControlResult<PermissionsSelect> };
  "subagent:list": {
    args: [req: { parentSessionId: string; scope?: SubagentScope }];
    result: ControlResult<SubagentCatalogView>;
  };
  "subagent:interrupt": { args: [req: { parentSessionId: string; childId: string }]; result: ControlResult<{ accepted: true }> };
  "subagent:message": {
    args: [req: { parentSessionId: string; childId: string; text: string }];
    result: ControlResult<{ messageId: string }>;
  };
  "session:job-kill": { args: [req: { jobId: string; sessionId: string }]; result: ControlResult<unknown> };
  "session:goal": { args: [req: { sessionId: string }]; result: ControlResult<GoalWire | null> };
  "session:feedback": { args: [req: PutMessageFeedbackInput]; result: ControlResult<MessageFeedbackItemWire> };
  "session:feedback-get": {
    args: [req: { sessionId: string; messageId: string }];
    result: ControlResult<MessageFeedbackItemWire | null>;
  };
  "session:schedule-list": { args: [req: { sessionId: string }]; result: ControlResult<ScheduleWire[]> };
  /** Registry commands (built-in + plugin) for the command palettes. */
  "cordis:listCommands": { args: []; result: Array<{ name: string; description: string }> };

  // ── Workspaces & projects ────────────────────────────────────────────────
  "db:workspace:list": { args: []; result: Workspace[] };
  "db:workspace:create": { args: [input: WorkspaceCreateInput]; result: Workspace };
  "db:workspace:update": { args: [req: { id: string; patch: WorkspacePatch }]; result: Workspace };
  /** All projects when workspaceId is omitted. */
  "db:project:list": { args: [req: { workspaceId?: string }]; result: Project[] };
  "db:project:create": {
    args: [input: ProjectCreateInput];
    result: { project: Project; columns: BoardColumn[] };
  };
  /** A rename also moves the project's notes folder on disk. */
  "db:project:update": { args: [req: { id: string; patch: ProjectPatch }]; result: Project };
  /** Merged into the stored settings; a null/undefined value removes that key. null if the project is gone. */
  "db:project:updateSettings": {
    args: [req: { id: string; settings: Partial<Record<keyof ProjectSettings, unknown>> }];
    result: Project | null;
  };
  "db:project:delete": { args: [req: { id: string }]; result: void };
  /** Move everything from source into target, then delete source. */
  "db:project:merge": { args: [req: { sourceId: string; targetId: string }]; result: ProjectMergeResult };

  // ── Board ────────────────────────────────────────────────────────────────
  "db:column:list": { args: [req: { projectId?: string }]; result: BoardColumn[] };
  "db:column:create": { args: [input: ColumnCreateInput]; result: BoardColumn };
  "db:column:update": { args: [req: { id: string; patch: ColumnPatch }]; result: BoardColumn };
  /** Deletes the column's cards too. */
  "db:column:delete": { args: [req: { id: string }]; result: void };
  /** Live (non-tombstoned) cards, by project or column. */
  "db:card:list": { args: [opts: { projectId?: string; columnId?: string } | undefined]; result: TaskCard[] };
  /** Rejects an empty title. */
  "db:card:create": { args: [input: CardCreateInput]; result: TaskCard };
  "db:card:update": { args: [req: { id: string; patch: CardPatch }]; result: TaskCard };
  "db:card:moveToProject": {
    args: [req: { id: string; projectId: string; columnId: string; order: number }];
    result: TaskCard;
  };
  "db:card:delete": { args: [req: { id: string }]; result: void };
  /** Archive every card in a column. */
  "db:cards:archive-done": { args: [req: { columnId: string }]; result: { archived: number } };
  /** Rejects self-blocks, cross-project blockers and cycles. */
  "db:card:addBlocker": { args: [req: { cardId: string; blockerCardId: string }]; result: TaskCard };
  "db:card:removeBlocker": { args: [req: { cardId: string; blockerCardId: string }]; result: TaskCard };
  /** Open, non-done cards whose blockers are all resolved. */
  "db:card:ready": { args: [req: { projectId?: string }]; result: TaskCard[] };

  // ── Tags ─────────────────────────────────────────────────────────────────
  "db:tag:list": { args: [req: { workspaceId?: string }]; result: Tag[] };
  "db:tag:create": { args: [input: TagCreateInput]; result: Tag };
  "db:tag:update": { args: [req: { id: string; patch: TagPatch }]; result: Tag };
  "db:tag:delete": { args: [req: { id: string }]; result: void };

  // ── Notes ────────────────────────────────────────────────────────────────
  /** Live notes (no tombstones), newest first; all projects when projectId is omitted. */
  "db:note:list": { args: [req: { projectId?: string }]; result: Note[] };
  "db:note:create": { args: [note: NoteCreateInput]; result: Note };
  /** Title changes also rename the .md file and rewrite inbound [[wikilinks]]. */
  "db:note:update": { args: [req: { id: string; patch: NotePatch }]; result: Note };
  /** Soft delete (tombstone) + .md removal. */
  "db:note:delete": { args: [req: { id: string }]; result: void };
  "db:note:moveToFolder": { args: [req: { id: string; folder: string }]; result: Note };
  /** workspaceId is derived from the target project; accepted for older callers. */
  "db:note:moveToProject": { args: [req: { id: string; projectId: string; workspaceId?: string }]; result: Note };
  "db:note:bodies:get": { args: [req: { ids: string[] }]; result: NoteBody[] };
  /** Full-text search; returns matching note ids. */
  "db:note:search": { args: [req: { query: string; projectId?: string }]; result: string[] };
  /** Ids of notes whose [[wikilinks]] point at this note. */
  "db:note:backlinks:list": { args: [req: { noteId: string }]; result: string[] };
  /** The user has seen this note's "what's new" changes. */
  "db:note:changeMark:clear": { args: [req: { id: string }]; result: void };

  // ── Idea Flow ────────────────────────────────────────────────────────────
  /** Resolved graph (absolute positions, linked note/card data, spatial hints); creates the flow if missing. */
  "db:flow:get": { args: [req: { projectId: string }]; result: ResolvedIdeaFlow };
  "db:flow:node:create": { args: [node: FlowNodeCreateInput]; result: IdeaFlowNode };
  "db:flow:node:update": { args: [req: { id: string; patch: FlowNodePatch }]; result: IdeaFlowNode };
  /** Edges touching the node cascade. */
  "db:flow:node:delete": { args: [req: { id: string }]; result: void };
  /** Summarise everything connected to an ai_summary node and store it on the node. */
  "db:flow:node:summarize": {
    args: [req: { nodeId: string; config: FlowAiConfig }];
    result: { nodeId: string; content: string };
  };
  "db:flow:edge:create": { args: [edge: FlowEdgeCreateInput]; result: IdeaFlowEdge };
  "db:flow:edge:delete": { args: [req: { id: string }]; result: void };
  /** OpenGraph title/description for a url node (fetched in main, no CORS). */
  "db:flow:url:fetch": { args: [req: { url: string }]; result: UrlMetadata };

  // ── Heartbeat automations ────────────────────────────────────────────────
  "db:automation:list": { args: [req: { workspaceId: string }]; result: Automation[] };
  "db:automation:get": { args: [req: { id: string }]; result: Automation | null };
  /** Rejects when the schedule is invalid or has no future run. */
  "db:automation:create": { args: [input: AutomationInput]; result: Automation };
  "db:automation:update": { args: [req: { id: string; patch: AutomationPatch }]; result: Automation | null };
  /** Removes the folder and keychain secrets before the row; rejects (keeping the row) if cleanup fails. */
  "db:automation:delete": { args: [req: { id: string }]; result: { ok: boolean; deleted: boolean } };
  "db:automation:runs": { args: [req: { automationId: string; limit?: number }]; result: AutomationRun[] };
  "db:automation:recentRuns": {
    args: [req: { workspaceId: string; projectId?: string | null; limit?: number }];
    result: AutomationRunWithAutomation[];
  };
  "db:automation:runningCount": { args: []; result: number };
  "db:automation:checkRequirements": {
    args: [req: { workspaceId: string; projectId?: string | null; requires: AutomationRequirement[] }];
    result: RequirementStatus[];
  };
  /** Daily budget (USD, null = none) and today's recorded automation spend. */
  "db:automation:budget:get": { args: []; result: { budgetUsd: number | null; spentTodayUsd: number } };
  "db:automation:budget:set": { args: [req: { usd: number | null }]; result: { budgetUsd: number | null } };
  /** `skipped` when the automation is already running. */
  "db:automation:runNow": { args: [req: { id: string }]; result: { runId: string } | { skipped: true } };
  /** Approve/deny a tool call a running automation is waiting on. */
  "automation:approve": {
    args: [req: { callId: string; approved: boolean; grant?: "session" | "always" }];
    result: void;
  };
  /** The automation's folder, created and populated if needed (Develop cwd). */
  "db:automation:folder": { args: [req: { id: string }]; result: { folder: string } };
  "db:automation:files": { args: [req: { id: string }]; result: { files: AutomationFolderFile[] } };
  "db:automation:runLog": { args: [req: { runId: string }]; result: { log: RunLog } };
  /** Apply the folder's manifest.json to the row; `dropped` lists rules that were unsafe to keep. */
  "db:automation:syncFromManifest": {
    args: [req: { id: string }];
    result: { automation: Automation; dropped: string[] };
  };
  "db:automation:env": { args: [req: { automationId: string }]; result: AutomationEnvSpec[] };
  /** Secret values go to the keychain only; returns the updated env spec. */
  "db:automation:env:set": {
    args: [req: { automationId: string; name: string; value: string; secret: boolean }];
    result: AutomationEnvSpec[];
  };
  "db:automation:env:delete": { args: [req: { automationId: string; name: string }]; result: AutomationEnvSpec[] };
  /** Next fire time for a proposed schedule (null when there's none). */
  "db:automation:preview": {
    args: [req: { scheduleKind?: string; scheduleExpr: string; timezone?: string | null }];
    result: { nextRunAt: string | null };
  };

  // ── Git (cwd must sit inside a project's code directory) ─────────────────
  "git:status": { args: [req: { cwd: string }]; result: GitStatus };
  "git:branches": { args: [req: { cwd: string }]; result: GitBranchList };
  "git:checkout": { args: [req: { cwd: string; branch: string; create?: boolean }]; result: { branch: string } };
  "git:stage": { args: [req: { cwd: string } & GitPathSelection]; result: { ok: boolean } };
  "git:unstage": { args: [req: { cwd: string } & GitPathSelection]; result: { ok: boolean } };
  /** `autoStage` runs `git add .` first; returns the short hash. */
  "git:commit": {
    args: [req: { cwd: string; message: string; body?: string; autoStage?: boolean }];
    result: { hash: string; message: string };
  };
  "git:push": { args: [req: { cwd: string; setUpstream?: boolean }]; result: { branch: string } };
  /** `count` is clamped to 1–100 (default 20). */
  "git:log": { args: [req: { cwd: string; count?: number }]; result: GitLogEntry[] };
  /** Unified diff of the index (`staged`) or the working tree against HEAD. */
  "git:diff": { args: [req: { cwd: string; staged?: boolean }]; result: string };
  "git:diffBranch": { args: [req: { cwd: string; baseBranch: string }]; result: string };
  "git:diffFile": { args: [req: { cwd: string; filePath: string; staged?: boolean }]; result: GitFileDiff };
  /** `list` returns the stash entries; `push` / `pop` return `{ ok }`. */
  "git:stash": { args: [req: { cwd: string; action: GitStashAction }]; result: string[] | { ok: boolean } };
  "git:createPr": {
    args: [req: { cwd: string; title: string; body?: string; base?: string }];
    result: { url: string; branch: string };
  };
  /** null when `gh` is missing or the branch has no PR. */
  "git:prStatus": { args: [req: { cwd: string }]; result: GitPrStatus | null };
  /** Restores a tracked file or deletes an untracked one. */
  "git:discard": { args: [req: { cwd: string; filePath: string }]; result: { ok: boolean } };

  // ── External tools: MCP servers ──────────────────────────────────────────
  "tools:listMcpServers": { args: [req: { workspaceId: string }]; result: McpServerConfig[] };
  /** Upsert; a missing `id` creates. Changing the endpoint/auth config clears stored OAuth state. */
  "tools:saveMcpServer": { args: [server: Partial<McpServerConfig>]; result: McpServerConfig };
  "tools:deleteMcpServer": { args: [req: { id: string }]; result: void };
  "tools:testMcp": { args: [req: { id: string }]; result: McpTestResult };
  "tools:listMcpTools": { args: [req: { id: string }]; result: ListMcpToolsResult };
  /** Opens the browser; completion arrives on the `tools:oauthCallback` event. */
  "tools:startMcpAuth": { args: [req: { id: string }]; result: AuthStartResult };
  "tools:mcpAuthStatus": { args: [req: { id: string }]; result: { connected: boolean } };
  "tools:signOutMcp": { args: [req: { id: string }]; result: void };
  "tools:cancelMcpAuth": { args: [req: { id: string }]; result: { cancelled: boolean } };

  // ── External tools: custom HTTP services ─────────────────────────────────
  "tools:listServices": { args: [req: { workspaceId: string }]; result: CustomServiceConfig[] };
  "tools:saveService": { args: [service: Partial<CustomServiceConfig>]; result: CustomServiceConfig };
  "tools:deleteService": { args: [req: { id: string }]; result: void };
  "tools:testService": {
    args: [req: { id: string; sampleArgs?: Record<string, unknown> }];
    result: ServiceTestResult;
  };
  "tools:startServiceAuth": { args: [req: { id: string }]; result: AuthStartResult };
  "tools:serviceAuthStatus": { args: [req: { id: string }]; result: { connected: boolean } };
  "tools:signOutService": { args: [req: { id: string }]; result: void };
  "tools:cancelServiceAuth": { args: [req: { id: string }]; result: { cancelled: boolean } };

  // ── External tools: per-project attachments ──────────────────────────────
  "tools:listAttachments": { args: [req: { projectId: string }]; result: ToolAttachment[] };
  "tools:setAttachment": { args: [attachment: ToolAttachment]; result: ToolAttachment };
  "tools:clearAttachment": { args: [attachment: Omit<ToolAttachment, "enabled">]; result: void };

  // ── Secrets (OS keychain) — no get: the renderer only learns set/not-set ──
  "secrets:available": { args: []; result: boolean };
  /** Returns the `secret://` ref to store in place of the value. */
  "secrets:set": { args: [req: { toolType: SecretToolType; toolId: string; key: string; value: string }]; result: string };
  "secrets:has": { args: [req: { toolType: SecretToolType; toolId: string; key: string }]; result: boolean };
  "secrets:delete": { args: [req: { toolType: SecretToolType; toolId: string; key: string }]; result: void };

  // ── In-app notification center ───────────────────────────────────────────
  "db:notification:list": { args: [req: { limit?: number }]; result: McpNotification[] };
  "db:notification:count": { args: []; result: number };
  "db:notification:markRead": { args: [req: { id: string }]; result: true };
  /** Returns the number of notifications deleted. */
  "db:notification:clear": { args: []; result: number };
  /** Marks every notification read and clears the dock/tray badge. */
  "mcp:markNotificationsRead": { args: []; result: void };

  // ── Workspace setup ──────────────────────────────────────────────────────
  /** null when the dialog is cancelled. */
  "app:selectWorkspaceFolder": { args: []; result: string | null };
  "app:getWorkspacePath": { args: []; result: string | null };
  "app:needsWorkspaceSetup": { args: []; result: boolean };
  /** Creates the folder, re-initialises on it, then persists it as the workspace. */
  "app:initWorkspace": { args: [req: { workspacePath: string; excludedFolders?: string[] }]; result: { ok: true } };
  "app:rescanWorkspace": {
    args: [req: { workspaceId?: string; excludedFolders?: string[] }];
    result: WorkspaceRescanResult;
  };
  /** Removes the projects an import created without tombstoning them to sync peers. */
  "app:rollbackImport": { args: [req: { projectIds: string[] }]; result: { removedNotes: number; ok: boolean } };
  "app:probeWorkspaceFolder": { args: [req: { folder: string }]; result: VaultImportPreview };
  "app:checkMigrations": { args: []; result: MigrationStatus[] };
  /** Progress arrives on the `app:migrationProgress` event. */
  "app:runMigration": { args: [req: { migrationId: string }]; result: { ok: true } };
  /** Wipes every table, then relaunches. */
  "app:reset": { args: []; result: void };
  "app:relaunch": { args: []; result: void };

  // ── App info, appearance and files ───────────────────────────────────────
  /** True when running unpackaged; gates dev-only UI. */
  "app:isDev": { args: []; result: boolean };
  "app:mcpServerPath": { args: []; result: string };
  /** The highest-versioned bundled changelog, or null when none ship. */
  "app:latestChangelog": { args: []; result: string | null };
  /** Persists the theme for the boot splash (and the Windows title bar). */
  "app:setTheme": { args: [theme: string]; result: void };
  "app:setAccent": { args: [accent: string]; result: void };
  "app:revealNote": { args: [req: { noteId: string; projectId: string }]; result: void };
  "app:revealAssets": { args: []; result: void };
  /** Saves a pasted file to the attachments folder; returns its `![[name]]` embed. */
  "app:uploadAsset": { args: [req: { filename: string; data: ArrayBuffer }]; result: { assetUrl: string } };
  /** null when the save dialog is cancelled; `pdfBase64` when `returnBuffer` is set. */
  "app:exportNotePdf": {
    args: [req: { title: string; html: string; options?: { returnBuffer?: boolean; theme?: PdfTheme; fontFamily?: string } }];
    result: { filePath?: string; pdfBase64?: string } | null;
  };
  /** null when the save dialog is cancelled; `markdown` + `title` when `returnText` is set. */
  "app:exportMarkdown": {
    args: [req: { kind: "note" | "project"; id: string; returnText?: boolean }];
    result: { filePath?: string; markdown?: string; title?: string } | null;
  };
  "app:llmLeftovers": { args: []; result: LlmLeftovers };
  "app:clearLlmLeftovers": { args: []; result: { reclaimedBytes: number } };

  // ── Cached settings (read by main before the renderer loads) ─────────────
  "app:getAiSettings": { args: []; result: Record<string, unknown> | null };
  "app:saveAiSettings": { args: [req: { config: Record<string, unknown> }]; result: { ok: true } };
  "app:getAgentSettings": { args: []; result: Record<string, unknown> | null };
  "app:saveAgentSettings": { args: [req: { config: Record<string, unknown> }]; result: { ok: true } };
  "app:getTheme": { args: []; result: string | null };
  "app:saveTheme": { args: [req: { theme: string }]; result: { ok: true } };
  "app:getFontScale": { args: []; result: number | null };
  "app:saveFontScale": { args: [req: { fontScale: number }]; result: { ok: true } };
  "app:getEmbeddingsSettings": { args: []; result: { enabled?: boolean; modelId?: string } | null };
  "app:saveEmbeddingsSettings": { args: [req: { config: { enabled?: boolean; modelId?: string } }]; result: { ok: true } };
  /** models.dev pricing map, used to estimate cost when a provider reports none. */
  "app:modelPricing": { args: [map: Record<string, ModelPrice> | null]; result: { ok: true } };
  /** Model ids that must never be sent a temperature. */
  "app:noTemperatureModels": { args: [ids: string[] | null]; result: { ok: true } };

  // ── AI helpers (reject when AI isn't configured or the model call fails) ──
  /** Generates a PRD and saves it as a note in the project. */
  "ai:generatePrd": {
    args: [req: { projectId: string; title: string; requirements: string; config: AiRequestConfig }];
    result: PrdResult;
  };
  "ai:generateCommitMessage": {
    args: [req: { diff: string; config: AiRequestConfig }];
    result: { subject: string; body: string };
  };
  "ai:generatePrDescription": {
    args: [req: { diff: string; config: AiRequestConfig; template?: string }];
    result: { title: string; description: string };
  };
  "ai:explainArchitecture": {
    args: [req: { summary: string; config: AiRequestConfig }];
    result: { overview: string; modules: string };
  };
  /** Model ids from `{baseUrl}/models` (embedding/audio/image models filtered out). */
  "ai:fetchModels": { args: [endpoint: AiEndpoint]; result: string[] };
  /** Remaining credits, or null when the provider doesn't expose them (never rejects for that). */
  "ai:fetchKeyInfo": { args: [endpoint: AiEndpoint]; result: CreditInfo | null };

  // ── Auto-updater ─────────────────────────────────────────────────────────
  /** Quits and installs the downloaded update. */
  "updater:install": { args: []; result: void };

  // ── Coding agents (CLI binaries run in a PTY) ────────────────────────────
  "agent:getCodingAgents": { args: []; result: CodingAgent[] };
  "agent:saveCodingAgent": { args: [agent: CodingAgentInput]; result: CodingAgent };
  "agent:deleteCodingAgent": { args: [req: { id: string }]; result: void };
  "agent:setDefaultAgent": { args: [req: { id: string }]; result: void };

  // ── Agent file browser (paths must sit inside a project's code directory) ─
  "agent:readDir": { args: [req: { dirPath: string }]; result: DirEntry[] };
  /** Filename substring match, at most 50 results. */
  "agent:searchFiles": { args: [req: { dirPath: string; query: string }]; result: FileSearchResult[] };
  "agent:readFile": { args: [req: { filePath: string }]; result: string };
  /** The file as a `data:` URL. */
  "agent:readFileBase64": { args: [req: { filePath: string }]; result: string };
  "agent:writeFile": { args: [req: { filePath: string; content: string }]; result: void };
  /** False (never rejects) for unsafe or missing paths. */
  "agent:validateDirectory": { args: [req: { dirPath: string }]; result: boolean };
  /** Tracked changes vs HEAD plus untracked files as synthesised new-file hunks. */
  "agent:gitDiff": { args: [req: { cwd: string }]; result: string };
  /** null when the dialog is cancelled or no window is focused. */
  "agent:pickDirectory": { args: []; result: string | null };
  "agent:pickFile": { args: []; result: string | null };

  // ── Codebase index (Architecture tab) ────────────────────────────────────
  "agent:codebaseOverview": { args: [req: { folder: string }]; result: CodebaseOverview };
  "agent:codebaseGraph": { args: [req: { folder: string }]; result: CodebaseGraph };
  /** `depth` defaults to 1. */
  "agent:codebaseModuleGraph": { args: [req: { folder: string; depth?: number }]; result: CodebaseModuleGraph };
  "agent:codebaseFileSymbols": { args: [req: { filePath: string }]; result: CodebaseSymbol[] };
  "agent:codebaseRelations": { args: [req: { name: string; folder?: string }]; result: CodebaseRelations };
  /** Re-indexes the folder and returns the fresh overview. */
  "agent:codebaseReindex": { args: [req: { folder: string }]; result: CodebaseOverview };
  /** False when the file isn't indexable. */
  "agent:codebaseReindexFile": { args: [req: { folder: string; filePath: string }]; result: boolean };

  // ── Terminals (output arrives on `agent:data` / `agent:exit`) ─────────────
  "agent:spawn": { args: [input: AgentSpawnInput]; result: { sessionId: string } };
  /** The user's login shell in `cwd` (bottom terminal pane). */
  "agent:spawnShell": { args: [req: { cwd: string }]; result: { sessionId: string } };
  "agent:input": { args: [req: { sessionId: string; data: string }]; result: void };
  "agent:resize": { args: [req: { sessionId: string; cols: number; rows: number }]; result: void };
  "agent:kill": { args: [req: { sessionId: string }]; result: void };
  /** Live agent-owned terminals with scrollback, for windows that open late. */
  "agent:modelTerminals": { args: []; result: ModelTerminal[] };

  // ── Snapshot + change feed ───────────────────────────────────────────────
  /** Every live entity; `noteBodies: false` omits note content (the renderer loads bodies lazily). */
  "db:snapshot": { args: [opts: { noteBodies?: boolean } | undefined]; result: EntitySnapshot };
  /** Rows changed since `since` (null = just return the head cursor). */
  "db:changes:get": { args: [req: { since: number | null; feedId: string | null }]; result: ChangeSet };
  /** True once any workspace exists. */
  "db:hasData": { args: []; result: boolean };
  /** Read-only MCP-style tool call from a dashboard iframe. */
  "db:mcpQuery": { args: [req: { tool: string; args: Record<string, unknown> }]; result: unknown };

  // ── Slash commands ───────────────────────────────────────────────────────
  "db:command:list": { args: [req: { workspaceId?: string }]; result: CustomSlashCommand[] };
  "db:command:create": { args: [input: SlashCommandCreateInput]; result: CustomSlashCommand };
  "db:command:update": { args: [req: { id: string; patch: SlashCommandPatch }]; result: CustomSlashCommand };
  "db:command:delete": { args: [req: { id: string }]; result: void };

  // ── Knowledge graph ──────────────────────────────────────────────────────
  "db:graph:get": { args: [req: { workspaceId: string; filters?: GraphQueryFilters }]; result: KnowledgeGraph };
  /** `depth` defaults to 1. */
  "db:graph:neighbors": {
    args: [req: { workspaceId: string; nodeId: string; depth?: number; edgeTypes?: GraphEdgeType[] }];
    result: NeighboursResult;
  };
  /** Recomputes auto relationships (all entities, or just `entityIds`). */
  "db:graph:recompute": { args: [req: { workspaceId: string; entityIds?: string[] }]; result: { ok: true } };

  // ── Usage log (Usage view) ───────────────────────────────────────────────
  /** Headline totals, the previous window, a per-day series and source/model breakdowns. */
  "usage:overview": { args: [req: UsageRangeArgs]; result: UsageOverview };
  /** Most recent per-call rows; `limit` defaults to 50. */
  "usage:recent": { args: [req: UsageRangeArgs & { limit?: number }]; result: UsageRecentRow[] };
  /** Per-thread rollups; `limit` defaults to 50. */
  "usage:threads": { args: [req: UsageRangeArgs & { limit?: number }]; result: UsageThreadGroup[] };
  /** Deletes the rows the filter selects. */
  "usage:clear": { args: [req: UsageRangeArgs]; result: { deleted: number; ok: true } };

  // ── Writing style ────────────────────────────────────────────────────────
  "user-style:get": { args: []; result: UserStyleRow | null };
  "user-style:save": { args: [req: { input: UserStyleSaveInput }]; result: UserStyleRow };
  "user-style:clear": { args: []; result: { ok: true } };
  /** One-shot generation (retries once at a lower temperature when unusable). */
  "user-style:generate": {
    args: [req: { step: UserStyleStep; input: UserStyleGenerationInput }];
    result: { markdown: string };
  };

  // ── "Always allow" grants ────────────────────────────────────────────────
  "approval-grants:list": { args: [req: { workspaceId: string }]; result: ApprovalGrant[] };
  "approval-grants:delete": { args: [req: { id: string }]; result: { deleted: boolean } };
  "approval-grants:clear-workspace": { args: [req: { workspaceId: string }]; result: { deleted: number } };

  // ── Desktop sync (synced-folder oplog) ───────────────────────────────────
  "sync:getFolder": { args: []; result: string | null };
  /** null when the dialog is cancelled. */
  "sync:selectFolder": { args: []; result: string | null };
  "sync:clearFolder": { args: []; result: { ok: true } };
  "sync:now": { args: []; result: DesktopSyncResult };
  /** Initial status; transitions are pushed on the `sync:status` event. */
  "sync:status": { args: []; result: SyncStatus };
  "sync:pendingBreakdown": { args: []; result: SyncPendingBreakdown };
  "sync:listConflicts": { args: []; result: ConflictCopy[] };
  /** `keepMerged` requires `mergedContent`. */
  "sync:resolveConflict": {
    args: [req: { copyId: string; action: ConflictResolution; mergedContent?: string }];
    result: { resolvedOriginalId: string | null };
  };
  /** Recent reconcile decisions; `limit` defaults to 100. */
  "sync:activity": { args: [req: { limit?: number }]; result: SyncActivityRow[] };
  /** Peers on a different sync protocol version. */
  "sync:peerProtocols": { args: []; result: PeerProtocol[] };
  /** Notes a peer deleted that can be restored; `total` may exceed `rows.length`. */
  "sync:listRestorable": { args: [req: { limit?: number }]; result: { rows: RestorableRow[]; total: number } };
  "sync:restoreNote": { args: [req: { id: string }]; result: { restored: boolean; reason?: string; fileError?: string } };
  /** Retries the .md write for a restore whose DB half already landed. */
  "sync:repairNoteFile": { args: [req: { id: string }]; result: { repaired: boolean; reason?: string; fileError?: string } };

  // ── Community catalog (cache-first; `refresh*` forces a network fetch) ───
  "registry:fetch": { args: []; result: RegistryFetchResult };
  "registry:refresh": { args: []; result: RegistryFetchResult };
  "registry:fetchProviders": { args: []; result: ProvidersFetchResult };
  "registry:refreshProviders": { args: []; result: ProvidersFetchResult };
  "registry:fetchAutomations": { args: []; result: AutomationsFetchResult };
  "registry:refreshAutomations": { args: []; result: AutomationsFetchResult };
  "registry:fetchPersonalities": { args: []; result: PersonalitiesFetchResult };
  "registry:refreshPersonalities": { args: []; result: PersonalitiesFetchResult };
  "registry:fetchChatThemes": { args: []; result: ChatThemesFetchResult };
  "registry:refreshChatThemes": { args: []; result: ChatThemesFetchResult };

  // ── Plugins (writes are gated behind CAIRN_PLUGINS_DEV=1 and reject otherwise) ─
  /** Enabled UI plugins and their bundled source. */
  "plugins:listUi": { args: []; result: UiPluginSource[] };
  "plugins:list": { args: []; result: PluginList };
  "plugins:setEnabled": { args: [req: { id: string; enabled: boolean }]; result: { ok: true } };
  "plugins:openFolder": { args: []; result: { ok: true } };
  /** `spec` is `github:owner/repo` or a local path. */
  "plugins:install": { args: [req: { spec: string }]; result: InstalledPlugin };
  /** Re-runs the plugin's recorded source spec. */
  "plugins:update": { args: [req: { id: string }]; result: InstalledPlugin };
  "plugins:uninstall": { args: [req: { id: string }]; result: { ok: true } };

  // ── Embeddings (semantic search + note map) ──────────────────────────────
  "embeddings:status": { args: []; result: EmbeddingsStatus };
  "embeddings:stop": { args: []; result: void };
  /** `needed` when stored vectors came from a different model than the configured one. */
  "embeddings:needsReindex": { args: []; result: { needed: boolean; reason: "model_changed" | null } };
  "embeddings:projections": {
    args: [req: { workspaceId: string }];
    result: { rows: NoteProjectionRow[]; anyStale: boolean; model: string };
  };
  /** Re-embeds the given notes (or the whole workspace, plus task cards). */
  "db:embeddings:reindex": { args: [req: { workspaceId: string; noteIds?: string[]; model?: string }]; result: ReindexResult };
  /** `k` defaults to 5; `queryNoteId` is excluded from the results. */
  "db:embeddings:search": {
    args: [req: { workspaceId: string; queryText: string; queryNoteId?: string; k?: number; excludeIds?: string[]; model?: string }];
    result: AdjacentNote[];
  };
  "db:embeddings:recomputeProjections": { args: [req: { workspaceId: string; model?: string }]; result: ProjectionResult };
  "embeddings:models:list": { args: []; result: EmbeddingModelManifestEntry[] };
  /** Downloads + warms the model; progress arrives on `embeddings:download-progress`. */
  "embeddings:models:install": { args: [req: { modelId: string }]; result: { ok: true } };
  "embeddings:models:remove": { args: [req: { modelId: string }]; result: { ok: true } };
  "embeddings:models:setDefault": { args: [req: { modelId: string }]; result: { ok: true } };

  // ── Unified runtime ──────────────────────────────────────────────────────
  "runtime:status": { args: []; result: RuntimeStatus };
  "runtime:stop": { args: []; result: { ok: true } };
  "runtime:embeddings:status": { args: []; result: EmbeddingsStatus };
  "runtime:embeddings:ensureStarted": { args: []; result: { ok: true } };
  "runtime:embeddings:models": { args: []; result: { models: RuntimeEmbeddingModel[] } };
  /** Progress arrives on `runtime:download-progress`. */
  "runtime:embeddings:install": { args: [req: { modelId: string }]; result: { ok: true } };
  "runtime:embeddings:remove": { args: [req: { modelId: string }]; result: { ok: true } };
  "runtime:embeddings:setDefault": { args: [req: { modelId: string }]; result: { ok: true } };

  // ── Agent runtime introspection (Settings → AI) ──────────────────────────
  /** Runs a dsh registry command (/plan, /compact, …) on the session's agent. */
  "cordis:executeCommand": { args: [req: { sessionId: string; line: string }]; result: { kind?: string; text?: string } };
  /** The assembled dsh system prompt; `error` is set (not thrown) when assembly fails. */
  "runtime:systemPrompt:preview": { args: [req: { cwd?: string; projectName?: string }]; result: SystemPromptPreview };
  /** The coding agent's plain-string prompt; `error` is set (not thrown) on failure. */
  "runtime:codingPrompt:preview": {
    args: [req: { cwd?: string; projectName?: string; taskTitle?: string }];
    result: { text: string; error?: string };
  };
  "runtime:tools:inventory": { args: []; result: ToolInventory };

  // ── Mobile Access ────────────────────────────────────────────────────────
  "mobile:status": { args: []; result: MobileStatus };
  /** Starts or stops the server per `enabled`; also pushed on `mobile:status-changed`. */
  "mobile:saveSettings": { args: [settings: Record<string, unknown>]; result: MobileStatus };
  "mobile:regeneratePin": { args: []; result: MobileStatus };
}

/** Main → renderer push events (webContents.send / broadcast) and their payloads. */
export interface IpcEvents {
  "automation:run": AutomationRunEvent;
  /** Unread notification count changed (bell + badge). */
  "mcp:unread-count": number;
  /** An MCP server / service OAuth sign-in finished (loopback or deep link). */
  "tools:oauthCallback": AuthCompleteResult;
  /** Global quick-capture shortcut / tray item fired. */
  "app:quick-capture": undefined;
  "app:migrationProgress": MigrationProgress;
  "updater:update-available": UpdateAvailableInfo;
  "updater:update-downloaded": undefined;
  /** Output from a PTY this renderer spawned (agent run or shell). */
  "agent:data": PtyDataEvent;
  "agent:exit": PtyExitEvent;
  /** Agent-owned terminals, broadcast to every window (observe only). */
  "agent:model-terminal": ModelPtyEvent;
  "chat:poppedIn": { sessionId: string };
  "chat:poppedOutClosed": undefined;
  "chat:sessionUpdated": ChatPopoutPayload;
  "chat:requestPopIn": undefined;
  /** Streaming writing-style generation (`user-style:generateStream`). */
  "user-style:token": { delta: string };
  "user-style:tool-call": UserStyleToolCallEvent;
  "user-style:tool-call-done": UserStyleToolCallDoneEvent;
  "user-style:done": UserStyleDoneEvent;
  /** Desktop sync status transitions. */
  "sync:status": SyncStatus;
  /** The plugins folder changed; re-pull `plugins:listUi`. */
  "plugins:ui-changed": undefined;
  "embeddings:download-progress": EmbeddingDownloadProgress;
  "runtime:download-progress": EmbeddingDownloadProgress;
  "mobile:status-changed": MobileStatus;
}

export type IpcChannel = keyof IpcContract;
export type IpcArgs<C extends IpcChannel> = IpcContract[C]["args"];
export type IpcReturn<C extends IpcChannel> = IpcContract[C]["result"];
export type IpcEventChannel = keyof IpcEvents;
/** Arguments after the channel for sending event `E`: none when it has no payload. */
export type IpcEventArgs<E extends IpcEventChannel> = IpcEvents[E] extends undefined ? [] : [payload: IpcEvents[E]];

/**
 * Runtime list of contract channels (tests check each one is registered). The
 * mapped type makes adding a channel to IpcContract without listing it here a
 * build error, and rejects any channel taking more than one argument.
 */
type ChannelRecord = { [C in IpcChannel]: IpcArgs<C> extends [] | [unknown] ? true : never };
const CHANNELS: ChannelRecord = {
  "chat:popOut": true,
  "chat:popoutReady": true,
  "chat:requestPopIn": true,
  "chat:popIn": true,
  "db:chat:threads": true,
  "db:chat:sessionMessages": true,
  "db:chat:upsertThread": true,
  "db:chat:deleteThread": true,
  "db:chat:clearThreadMessages": true,
  "db:chat:clearAllThreads": true,
  "chat:compactThread": true,
  "chat:summarizeTranscript": true,
  "db:session:list": true,
  "db:session:create": true,
  "db:session:delete": true,
  "db:session:todos": true,
  "db:session:messages": true,
  "session:is-running": true,
  "session:running-ids": true,
  "session:context-ring": true,
  "session:title": true,
  "session:renameTitle": true,
  "session:permissions": true,
  "session:permissions:set": true,
  "subagent:list": true,
  "subagent:interrupt": true,
  "subagent:message": true,
  "session:job-kill": true,
  "session:goal": true,
  "session:feedback": true,
  "session:feedback-get": true,
  "session:schedule-list": true,
  "cordis:listCommands": true,
  "db:workspace:list": true,
  "db:workspace:create": true,
  "db:workspace:update": true,
  "db:project:list": true,
  "db:project:create": true,
  "db:project:update": true,
  "db:project:updateSettings": true,
  "db:project:delete": true,
  "db:project:merge": true,
  "db:column:list": true,
  "db:column:create": true,
  "db:column:update": true,
  "db:column:delete": true,
  "db:card:list": true,
  "db:card:create": true,
  "db:card:update": true,
  "db:card:moveToProject": true,
  "db:card:delete": true,
  "db:cards:archive-done": true,
  "db:card:addBlocker": true,
  "db:card:removeBlocker": true,
  "db:card:ready": true,
  "db:tag:list": true,
  "db:tag:create": true,
  "db:tag:update": true,
  "db:tag:delete": true,
  "db:note:list": true,
  "db:note:create": true,
  "db:note:update": true,
  "db:note:delete": true,
  "db:note:moveToFolder": true,
  "db:note:moveToProject": true,
  "db:note:bodies:get": true,
  "db:note:search": true,
  "db:note:backlinks:list": true,
  "db:note:changeMark:clear": true,
  "db:flow:get": true,
  "db:flow:node:create": true,
  "db:flow:node:update": true,
  "db:flow:node:delete": true,
  "db:flow:node:summarize": true,
  "db:flow:edge:create": true,
  "db:flow:edge:delete": true,
  "db:flow:url:fetch": true,
  "db:automation:list": true,
  "db:automation:get": true,
  "db:automation:create": true,
  "db:automation:update": true,
  "db:automation:delete": true,
  "db:automation:runs": true,
  "db:automation:recentRuns": true,
  "db:automation:runningCount": true,
  "db:automation:checkRequirements": true,
  "db:automation:budget:get": true,
  "db:automation:budget:set": true,
  "db:automation:runNow": true,
  "automation:approve": true,
  "db:automation:folder": true,
  "db:automation:files": true,
  "db:automation:runLog": true,
  "db:automation:syncFromManifest": true,
  "db:automation:env": true,
  "db:automation:env:set": true,
  "db:automation:env:delete": true,
  "db:automation:preview": true,
  "git:status": true,
  "git:branches": true,
  "git:checkout": true,
  "git:stage": true,
  "git:unstage": true,
  "git:commit": true,
  "git:push": true,
  "git:log": true,
  "git:diff": true,
  "git:diffBranch": true,
  "git:diffFile": true,
  "git:stash": true,
  "git:createPr": true,
  "git:prStatus": true,
  "git:discard": true,
  "tools:listMcpServers": true,
  "tools:saveMcpServer": true,
  "tools:deleteMcpServer": true,
  "tools:testMcp": true,
  "tools:listMcpTools": true,
  "tools:startMcpAuth": true,
  "tools:mcpAuthStatus": true,
  "tools:signOutMcp": true,
  "tools:cancelMcpAuth": true,
  "tools:listServices": true,
  "tools:saveService": true,
  "tools:deleteService": true,
  "tools:testService": true,
  "tools:startServiceAuth": true,
  "tools:serviceAuthStatus": true,
  "tools:signOutService": true,
  "tools:cancelServiceAuth": true,
  "tools:listAttachments": true,
  "tools:setAttachment": true,
  "tools:clearAttachment": true,
  "secrets:available": true,
  "secrets:set": true,
  "secrets:has": true,
  "secrets:delete": true,
  "db:notification:list": true,
  "db:notification:count": true,
  "db:notification:markRead": true,
  "db:notification:clear": true,
  "mcp:markNotificationsRead": true,
  "app:selectWorkspaceFolder": true,
  "app:getWorkspacePath": true,
  "app:needsWorkspaceSetup": true,
  "app:initWorkspace": true,
  "app:rescanWorkspace": true,
  "app:rollbackImport": true,
  "app:probeWorkspaceFolder": true,
  "app:checkMigrations": true,
  "app:runMigration": true,
  "app:reset": true,
  "app:relaunch": true,
  "app:isDev": true,
  "app:mcpServerPath": true,
  "app:latestChangelog": true,
  "app:setTheme": true,
  "app:setAccent": true,
  "app:revealNote": true,
  "app:revealAssets": true,
  "app:uploadAsset": true,
  "app:exportNotePdf": true,
  "app:exportMarkdown": true,
  "app:llmLeftovers": true,
  "app:clearLlmLeftovers": true,
  "app:getAiSettings": true,
  "app:saveAiSettings": true,
  "app:getAgentSettings": true,
  "app:saveAgentSettings": true,
  "app:getTheme": true,
  "app:saveTheme": true,
  "app:getFontScale": true,
  "app:saveFontScale": true,
  "app:getEmbeddingsSettings": true,
  "app:saveEmbeddingsSettings": true,
  "app:modelPricing": true,
  "app:noTemperatureModels": true,
  "ai:generatePrd": true,
  "ai:generateCommitMessage": true,
  "ai:generatePrDescription": true,
  "ai:explainArchitecture": true,
  "ai:fetchModels": true,
  "ai:fetchKeyInfo": true,
  "updater:install": true,
  "agent:getCodingAgents": true,
  "agent:saveCodingAgent": true,
  "agent:deleteCodingAgent": true,
  "agent:setDefaultAgent": true,
  "agent:readDir": true,
  "agent:searchFiles": true,
  "agent:readFile": true,
  "agent:readFileBase64": true,
  "agent:writeFile": true,
  "agent:validateDirectory": true,
  "agent:gitDiff": true,
  "agent:pickDirectory": true,
  "agent:pickFile": true,
  "agent:codebaseOverview": true,
  "agent:codebaseGraph": true,
  "agent:codebaseModuleGraph": true,
  "agent:codebaseFileSymbols": true,
  "agent:codebaseRelations": true,
  "agent:codebaseReindex": true,
  "agent:codebaseReindexFile": true,
  "agent:spawn": true,
  "agent:spawnShell": true,
  "agent:input": true,
  "agent:resize": true,
  "agent:kill": true,
  "agent:modelTerminals": true,
  "db:snapshot": true,
  "db:changes:get": true,
  "db:hasData": true,
  "db:mcpQuery": true,
  "db:command:list": true,
  "db:command:create": true,
  "db:command:update": true,
  "db:command:delete": true,
  "db:graph:get": true,
  "db:graph:neighbors": true,
  "db:graph:recompute": true,
  "usage:overview": true,
  "usage:recent": true,
  "usage:threads": true,
  "usage:clear": true,
  "user-style:get": true,
  "user-style:save": true,
  "user-style:clear": true,
  "user-style:generate": true,
  "approval-grants:list": true,
  "approval-grants:delete": true,
  "approval-grants:clear-workspace": true,
  "sync:getFolder": true,
  "sync:selectFolder": true,
  "sync:clearFolder": true,
  "sync:now": true,
  "sync:status": true,
  "sync:pendingBreakdown": true,
  "sync:listConflicts": true,
  "sync:resolveConflict": true,
  "sync:activity": true,
  "sync:peerProtocols": true,
  "sync:listRestorable": true,
  "sync:restoreNote": true,
  "sync:repairNoteFile": true,
  "registry:fetch": true,
  "registry:refresh": true,
  "registry:fetchProviders": true,
  "registry:refreshProviders": true,
  "registry:fetchAutomations": true,
  "registry:refreshAutomations": true,
  "registry:fetchPersonalities": true,
  "registry:refreshPersonalities": true,
  "registry:fetchChatThemes": true,
  "registry:refreshChatThemes": true,
  "plugins:listUi": true,
  "plugins:list": true,
  "plugins:setEnabled": true,
  "plugins:openFolder": true,
  "plugins:install": true,
  "plugins:update": true,
  "plugins:uninstall": true,
  "embeddings:status": true,
  "embeddings:stop": true,
  "embeddings:needsReindex": true,
  "embeddings:projections": true,
  "db:embeddings:reindex": true,
  "db:embeddings:search": true,
  "db:embeddings:recomputeProjections": true,
  "embeddings:models:list": true,
  "embeddings:models:install": true,
  "embeddings:models:remove": true,
  "embeddings:models:setDefault": true,
  "runtime:status": true,
  "runtime:stop": true,
  "runtime:embeddings:status": true,
  "runtime:embeddings:ensureStarted": true,
  "runtime:embeddings:models": true,
  "runtime:embeddings:install": true,
  "runtime:embeddings:remove": true,
  "runtime:embeddings:setDefault": true,
  "cordis:executeCommand": true,
  "runtime:systemPrompt:preview": true,
  "runtime:codingPrompt:preview": true,
  "runtime:tools:inventory": true,
  "mobile:status": true,
  "mobile:saveSettings": true,
  "mobile:regeneratePin": true,
};

export const IPC_CONTRACT_CHANNELS = Object.keys(CHANNELS) as IpcChannel[];
