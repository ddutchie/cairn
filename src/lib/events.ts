/**
 * Typed helpers for Cairn's internal CustomEvent bus.
 * Use these instead of raw dispatchEvent(new CustomEvent(...)) calls.
 */

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
};
