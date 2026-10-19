import { useEffect } from "react";
import * as QuickActions from "expo-quick-actions";
import { useQuickActionRouting, type RouterAction } from "expo-quick-actions/router";

const ACTIONS: RouterAction[] = [
  { id: "capture", title: "Quick capture", icon: "symbol:square.and.pencil", params: { href: "/capture" } },
  { id: "search", title: "Search", icon: "symbol:magnifyingglass", params: { href: "/search" } },
];

/**
 * Home-screen quick actions (long-press the app icon). Registers the shortcut
 * items once and routes a tapped one — including the cold-start launch — to its
 * `params.href`. Must be mounted inside a sub-layout (not the root layout),
 * since routing a quick action navigates.
 */
export function useAppQuickActions(): void {
  useQuickActionRouting();
  useEffect(() => {
    QuickActions.setItems(ACTIONS).catch((e) => console.warn("[quick-actions] setItems failed:", e));
  }, []);
}
