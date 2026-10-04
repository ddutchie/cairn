import { useEffect, useRef, type RefObject } from "react";

type ElRef = RefObject<Element | null>;

export interface ClickOutsideOptions {
  /**
   * CSS selector for elements that count as "inside" even though they live
   * outside the ref'd subtree — portaled popovers, or a toggle button whose own
   * onClick flips the open state (otherwise mousedown closes and click reopens).
   */
  ignore?: string;
}

/**
 * Call `onOutside` on a document mousedown that lands outside every ref'd
 * element. Pass `enabled = false` (usually the popover's open flag) to detach
 * the listener while closed. Pair with `useEscapeKey` for Escape-to-close.
 *
 * The latest `onOutside` is always used, so inline closures are fine and don't
 * re-bind the listener on every render.
 */
export function useClickOutside(
  refs: ElRef | ElRef[],
  onOutside: () => void,
  enabled = true,
  opts: ClickOutsideOptions = {},
): void {
  const cb = useRef(onOutside);
  const refList = useRef<ElRef[]>([]);
  useEffect(() => {
    cb.current = onOutside;
    refList.current = Array.isArray(refs) ? refs : [refs];
  });
  const { ignore } = opts;

  useEffect(() => {
    if (!enabled) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (refList.current.some((r) => r.current?.contains(target))) return;
      if (ignore && target instanceof Element && target.closest(ignore)) return;
      cb.current();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [enabled, ignore]);
}
