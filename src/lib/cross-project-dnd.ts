/**
 * Cross-project drag-and-drop payload contract.
 *
 * Used to drag items (a notes folder, or a task card) from one place in the app
 * onto a project row in the leftmost sidebar to move them to another project.
 *
 * We piggyback on the native HTML5 DataTransfer with a custom MIME type so the
 * payload survives across independent components (notes sidebar, kanban board,
 * project sidebar) without a shared React ref or global store field.
 *
 * dnd-kit (used by the board) doesn't expose the native dataTransfer on its
 * synthetic events, so the board also mirrors the active payload into a module
 * singleton (`activeCrossProjectDrag`) that the sidebar can read on drop.
 */

export const CROSS_PROJECT_DND_MIME = "application/x-cairn-cross-project";

export type CrossProjectDragPayload =
  | { kind: "folder"; sourceProjectId: string; folderPath: string; label: string }
  | { kind: "note"; noteId: string; sourceProjectId: string; label: string }
  | { kind: "card"; cardId: string; sourceProjectId: string; label: string };

/**
 * Module-level mirror of the payload currently being dragged. Set on drag start,
 * cleared on drag end. The sidebar reads this as a fallback when the native
 * dataTransfer isn't available (e.g. a dnd-kit-originated drag).
 */
let active: CrossProjectDragPayload | null = null;

export function setActiveCrossProjectDrag(payload: CrossProjectDragPayload | null): void {
  active = payload;
}

export function getActiveCrossProjectDrag(): CrossProjectDragPayload | null {
  return active;
}
