import { useCairnStore } from "@/store";
import type { CairnNameLookup } from "./humanize-tool";

/**
 * Store-backed id → name resolver for tool-call / approval titles. Reads the
 * store at render time (no subscription), so a transcript doesn't re-render
 * on every unrelated note or card change; an id that isn't loaded resolves to
 * undefined and the title falls back to the raw id.
 */
export const cairnNameLookup: CairnNameLookup = {
  note: (id) => useCairnStore.getState().notes.find((n) => n.id === id)?.title,
  task: (id) => useCairnStore.getState().cards.find((c) => c.id === id)?.title,
  project: (id) => useCairnStore.getState().projects.find((p) => p.id === id)?.name,
  column: (id) => useCairnStore.getState().columns.find((c) => c.id === id)?.name,
};
