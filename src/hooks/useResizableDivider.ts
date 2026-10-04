import { useEffect, useRef, type DependencyList, type RefObject } from "react";

export interface ResizableDividerOptions {
  /** "x" drags horizontally (col-resize), "y" vertically (row-resize). */
  axis: "x" | "y";
  /** Called at mousedown, before `startSize`. */
  onStart?: () => void;
  /** Size of the panel when the drag starts, read from the DOM at mousedown. */
  startSize: () => number;
  /**
   * Called on every mousemove with the pointer's travel since mousedown
   * (positive = right / down) and the size captured by `startSize`.
   */
  onMove: (delta: number, startSize: number) => void;
  /**
   * Called once when the drag ends. `interrupted` is true when the hook tore
   * down mid-drag (the divider unmounted or `deps` changed) and mouseup never
   * fired, so callers can still commit the latest size.
   */
  onEnd?: (interrupted: boolean) => void;
}

/**
 * Mouse drag for a panel divider: mousedown on `dividerRef`, window
 * mousemove/mouseup, and the body cursor/user-select lock while dragging.
 *
 * Callbacks are read through a ref, so they may close over fresh state without
 * re-attaching listeners. Pass `deps` that change when the divider element
 * mounts or remounts (e.g. a panel that only renders in some states).
 */
export function useResizableDivider(
  dividerRef: RefObject<HTMLElement | null>,
  options: ResizableDividerOptions,
  deps: DependencyList = [],
): void {
  const opts = useRef(options);
  useEffect(() => { opts.current = options; });

  useEffect(() => {
    const divider = dividerRef.current;
    if (!divider) return;

    let dragging = false;
    let startPos = 0;
    let startSize = 0;
    const pos = (e: MouseEvent) => (opts.current.axis === "x" ? e.clientX : e.clientY);
    const unlockBody = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    function onMouseDown(e: MouseEvent) {
      dragging = true;
      opts.current.onStart?.();
      startPos = pos(e);
      startSize = opts.current.startSize();
      document.body.style.cursor = opts.current.axis === "x" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    }

    function onMouseMove(e: MouseEvent) {
      if (dragging) opts.current.onMove(pos(e) - startPos, startSize);
    }

    function onMouseUp() {
      if (!dragging) return;
      dragging = false;
      unlockBody();
      opts.current.onEnd?.(false);
    }

    divider.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      divider.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      unlockBody();
      if (dragging) {
        dragging = false;
        opts.current.onEnd?.(true);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-supplied deps
  }, deps);
}
