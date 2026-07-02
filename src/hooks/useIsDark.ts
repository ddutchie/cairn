"use client";

import { useSyncExternalStore } from "react";
import { getIsDark } from "@/lib/utils";

/**
 * Reactive dark-mode hook. Subscribes to `data-theme` mutations on `<html>`
 * and re-renders the consumer when the theme changes. Backed by the same
 * canonical read as the imperative `getIsDark()` in `lib/utils`.
 *
 * Use this in React components that render theme-dependent colours so they
 * stay correct across live theme switches (the older inline
 * `getAttribute("data-theme")` reads did not re-render on change).
 */

function subscribe(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

export function useIsDark(): boolean {
  return useSyncExternalStore(
    subscribe,
    getIsDark,
    getIsDark, // server/hydration snapshot — reads the DOM if present, else safely defaults to dark
  );
}
