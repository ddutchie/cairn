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
 * Switch view, then reveal a target after the view has mounted. See
 * `navigateAndReveal` for the readiness strategy.
 */
type ActiveView = AppUIState["activeView"];
type SetView = (view: ActiveView) => void;

/**
 * Switch to `view`, then—once the target view has had a chance to mount its
 * CustomEvent listener—dispatch `event`. Consolidates the
 * `setView(...); setTimeout(() => window.dispatchEvent(...), 50)` idiom that
 * was duplicated across chat, kanban, project-overview, and ref chips.
 *
 * Instead of a fixed magic-number delay, we wait for two animation frames: the
 * first lets React commit the view switch, the second fires after the browser
 * has painted the newly-mounted view (and thus attached its listener). This is
 * more reliable than a hard-coded timeout when mounting is slower than expected.
 * Falls back to a `setTimeout` when `requestAnimationFrame` is unavailable
 * (e.g. non-DOM environments).
 */
export function navigateAndReveal(setView: SetView, view: ActiveView, event: Event) {
  setView(view);
  const fire = () => window.dispatchEvent(event);
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => requestAnimationFrame(fire));
  } else {
    setTimeout(fire, 50);
  }
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
