import { Platform } from "react-native";
import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

/**
 * iPad tab sidebar groups (Mail-style): rows listed under one native tab in
 * the sidebar, e.g. each project under Projects. Selecting a row is reported
 * via `onSelectItem`; the tab itself is unchanged. No-op off iPad / iOS < 18.
 */
export interface SidebarItem {
  id: string;
  title: string;
  /** SF Symbol name. */
  icon?: string;
}

interface TabSidebarModule {
  setGroup(index: number, items: SidebarItem[], selectedId: string | null): void;
  addListener(event: "onSelectItem", listener: (e: { id: string }) => void): EventSubscription;
}

const native = Platform.OS === "ios" ? requireOptionalNativeModule<TabSidebarModule>("TabSidebar") : null;

export function setSidebarGroup(index: number, items: SidebarItem[], selectedId: string | null): void {
  native?.setGroup(index, items, selectedId);
}

export function onSidebarItem(listener: (id: string) => void): () => void {
  const sub = native?.addListener("onSelectItem", (e) => listener(e.id));
  return () => sub?.remove();
}
