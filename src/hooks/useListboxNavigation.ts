"use client";

import { useCallback, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

/** Make an arbitrary string safe for use in an aria id. */
export function sanitizeAriaId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Roving-tabindex arrow-key navigation for a `[role="listbox"]` container
 * (ArrowUp/Down with wrap-around, Home/End). Shared by SessionBrowser and
 * the chat session popout so keyboard behavior stays identical.
 */
export function useListboxNavigation(ref: RefObject<HTMLDivElement | null>) {
  return useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return;
      const container = ref.current;
      if (!container) return;
      const options = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
      if (options.length === 0) return;
      const activeEl = document.activeElement as HTMLElement | null;
      const currentIndex = activeEl ? options.indexOf(activeEl) : -1;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = currentIndex < options.length - 1 ? currentIndex + 1 : 0;
        options[next]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = currentIndex > 0 ? currentIndex - 1 : options.length - 1;
        options[prev]?.focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        options[0]?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        options[options.length - 1]?.focus();
      }
    },
    [ref],
  );
}
