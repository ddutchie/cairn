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
  GitBranchList, GitFileDiff, GitLogEntry, GitPathSelection, GitPrStatus, GitStashAction, GitStatus,
} from "../types/git";
import type {
  FlowAiConfig, FlowEdgeCreateInput, FlowNodeCreateInput, FlowNodePatch, IdeaFlowEdge, IdeaFlowNode,
  ResolvedIdeaFlow, UrlMetadata,
} from "../types/flow";
import type { Note, NoteBody, NoteCreateInput, NotePatch } from "../types/notes";

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
}

/** Main → renderer push events (webContents.send / broadcast) and their payloads. */
export interface IpcEvents {
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
};

export const IPC_CONTRACT_CHANNELS = Object.keys(CHANNELS) as IpcChannel[];
