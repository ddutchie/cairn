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
  AuthCompleteResult, AuthStartResult, CustomServiceConfig, ListMcpToolsResult, McpServerConfig, McpTestResult,
  SecretToolType, ServiceTestResult, ToolAttachment,
} from "../types/tools";

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
}

/** Main → renderer push events (webContents.send / broadcast) and their payloads. */
export interface IpcEvents {
  "automation:run": AutomationRunEvent;
  /** Unread notification count changed (bell + badge). */
  "mcp:unread-count": number;
  /** An MCP server / service OAuth sign-in finished (loopback or deep link). */
  "tools:oauthCallback": AuthCompleteResult;
  "chat:poppedIn": { sessionId: string };
  "chat:poppedOutClosed": undefined;
  "chat:sessionUpdated": ChatPopoutPayload;
  "chat:requestPopIn": undefined;
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
};

export const IPC_CONTRACT_CHANNELS = Object.keys(CHANNELS) as IpcChannel[];
