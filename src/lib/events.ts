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
};
