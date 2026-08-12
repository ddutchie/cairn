import { NativeModule, requireOptionalNativeModule } from "expo";
import type { SearchScopeSelectionEvent } from "./SearchScope.types";

export * from "./SearchScope.types";

/**
 * Native surface of the `search-scope` module: drives the real UIKit
 * `UISearchController` scope bar (the Apple-Music-style [All | Notes | Tasks]
 * toggles that live inside the native search field) on the search screen.
 * iOS only — the JS layer must fall back to its own toggle everywhere else.
 */
declare class SearchScopeNativeModule extends NativeModule<{
  scopeSelected: (event: SearchScopeSelectionEvent) => void;
}> {
  /**
   * Attach scope titles to the active screen's search controller. Resolves
   * true when a search bar was found and configured. Callers should retry on
   * the next frame when the header config hasn't applied yet (screen just
   * mounted). UIKit animates the scope bar in/out with the search field's
   * focus state and the header height with it — nothing to animate on JS.
   */
  setScope(titles: string[], selectedIndex: number): Promise<boolean>;
  /** Update the selected segment without touching the titles. */
  setSelectedIndex(index: number): Promise<void>;
  /** Remove the scope bar from the active search controller. */
  clear(): Promise<void>;
  /** True when a search controller is active right now (synchronous probe). */
  isSearchActive(): boolean;
}

/**
 * The native module, or null when it isn't present (Expo Go, web, Android, or a
 * build that didn't include it). Optional so importing never throws — always
 * guard with `isNativeSearchScopeAvailable()`.
 */
export const SearchScope =
  requireOptionalNativeModule<SearchScopeNativeModule>("SearchScope");

/** Whether the native scope-bar module exists in this build. */
export function isNativeSearchScopeAvailable(): boolean {
  return !!SearchScope;
}

/** Attach the All|Notes|Tasks scope bar to the native search field. */
export async function setNativeSearchScope(
  titles: string[],
  selectedIndex: number,
): Promise<boolean> {
  if (!SearchScope) return false;
  return SearchScope.setScope(titles, selectedIndex);
}

/** Programmatically move the native scope selection (JS-side filter change). */
export async function setNativeSearchScopeIndex(index: number): Promise<void> {
  if (!SearchScope) return;
  return SearchScope.setSelectedIndex(index);
}

/** Detach the scope bar (search screen lost focus). */
export async function clearNativeSearchScope(): Promise<void> {
  if (!SearchScope) return;
  return SearchScope.clear();
}

/**
 * Subscribe to native scope taps. Returns null when the module isn't present.
 * The returned subscription has a `.remove()`.
 */
export function subscribeNativeSearchScope(
  listener: (index: number) => void,
): { remove: () => void } | null {
  if (!SearchScope) return null;
  return SearchScope.addListener("scopeSelected", (e: { index: number }) =>
    listener(e.index),
  );
}
