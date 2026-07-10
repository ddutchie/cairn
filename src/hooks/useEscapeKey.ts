import { useEffect } from "react";

/**
 * Close-on-Escape for hand-rolled overlays (search panel, popovers, pickers)
 * that manage their own open state and aren't built on the Radix `Dialog`
 * wrapper (which already handles Escape at the document level).
 *
 * Binds a document-level `keydown` listener so Escape fires regardless of where
 * focus is — fixing the common bug where Escape only closes a modal while its
 * `<input>` is focused. Pass `enabled = false` (e.g. the modal's open flag) to
 * detach the listener while closed.
 *
 * Uses the capture phase so it runs before element-level `onKeyDown` handlers,
 * and stops propagation so a single Escape doesn't also trigger a parent
 * overlay's handler (nested pickers close one layer at a time).
 */
export function useEscapeKey(onEscape: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onEscape();
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [onEscape, enabled]);
}
