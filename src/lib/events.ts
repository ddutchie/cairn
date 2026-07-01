/**
 * Typed helpers for Cairn's internal CustomEvent bus.
 * Use these instead of raw dispatchEvent(new CustomEvent(...)) calls.
 */

import type { AppUIState } from "@/types";

export const CairnEvents = {
  selectNote: (noteId: string) =>
    new CustomEvent("cairn:select-note", { detail: { noteId } }),
  openCard: (cardId: string) =>
    new CustomEvent("cairn:open-card", { detail: { cardId } }),
  scrollToColumn: (columnId: string) =>
    new CustomEvent("cairn:scroll-to-column", { detail: { columnId } }),
  newNote: () =>
    new CustomEvent("cairn:new-note"),
  /** Fired by the ipc() helper when a write operation returns { error }. */
  ipcError: (message: string) =>
    new CustomEvent("cairn:ipc-error", { detail: { message } }),
  /** Opens the chat panel and pre-fills the input with the given text, optionally sending it automatically. */
  openChat: (prefill: string, autoSend?: boolean) =>
    new CustomEvent("cairn:open-chat", { detail: { prefill, autoSend } }),
  /** Navigates to notes view and applies a tag filter. */
  filterByTag: (tagId: string) =>
    new CustomEvent("cairn:filter-by-tag", { detail: { tagId } }),
  /**
   * Fired by the Agent GitView when the set of changed/untracked files in the
   * working tree changes (detected via its git-status poll). The FileTree
   * listens and refreshes so externally added/removed files appear without a
   * manual refresh.
   */
  agentFilesChanged: () =>
    new CustomEvent("cairn:agent-files-changed"),
};

/**
 * Delay (ms) between switching views and dispatching the reveal event. The
 * target view needs one render cycle to mount its CustomEvent listener before
 * we fire, otherwise the event is missed. Centralised here so the magic number
 * lives in exactly one place.
 */
const REVEAL_DELAY_MS = 50;

type ActiveView = AppUIState["activeView"];
type SetView = (view: ActiveView) => void;

/**
 * Switch to `view`, then—after the target view has had a render cycle to mount
 * its listener—dispatch `event`. Consolidates the
 * `setView(...); setTimeout(() => window.dispatchEvent(...), 50)` idiom that
 * was duplicated across chat, kanban, project-overview, and ref chips.
 */
export function navigateAndReveal(setView: SetView, view: ActiveView, event: Event) {
  setView(view);
  setTimeout(() => window.dispatchEvent(event), REVEAL_DELAY_MS);
}

/** Navigate to the Notes view and select the given note. */
export function revealNote(setView: SetView, noteId: string) {
  navigateAndReveal(setView, "notes", CairnEvents.selectNote(noteId));
}

/** Navigate to the Board view and open the given card. */
export function revealCard(setView: SetView, cardId: string) {
  navigateAndReveal(setView, "board", CairnEvents.openCard(cardId));
}

/** Navigate to the Board view and scroll to the given column. */
export function revealColumn(setView: SetView, columnId: string) {
  navigateAndReveal(setView, "board", CairnEvents.scrollToColumn(columnId));
}
