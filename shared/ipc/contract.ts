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
};

export const IPC_CONTRACT_CHANNELS = Object.keys(CHANNELS) as IpcChannel[];
