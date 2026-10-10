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
  /** Nested rows (shown as a collapsible group), e.g. a project's views. */
  children?: SidebarItem[];
}

interface TabSidebarModule {
  setGroup(index: number, items: SidebarItem[], selectedPath: string[]): void;
  addListener(event: "onSelectItem", listener: (e: { id: string }) => void): EventSubscription;
}

const native = Platform.OS === "ios" ? requireOptionalNativeModule<TabSidebarModule>("TabSidebar") : null;

/** Shows `items` under tab `index`; `selectedPath` is the highlighted row's ids. */
export function setSidebarGroup(index: number, items: SidebarItem[], selectedPath: string[]): void {
  native?.setGroup(index, items, selectedPath);
}

/** Reports a tapped row as its path of ids, e.g. [projectId, "board"]. */
export function onSidebarItem(listener: (path: string[]) => void): () => void {
  const sub = native?.addListener("onSelectItem", (e) => listener(e.id.split("/")));
  return () => sub?.remove();
}
