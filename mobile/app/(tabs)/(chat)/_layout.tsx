import { TabStack } from "@/components/TabStack";

// The tab's first screen. The tab is a group, so its list is no longer a plain `index` route and
// the stack would not seed it: opening a deeper screen first (a link, the pinned tool) left it as
// the only screen, and re-tapping the tab had nothing to pop back to.
export const unstable_settings = { anchor: "chat/index" };

export default function ChatLayout() {
  // Chat uses a standard (non-large) header — a scrolling large title fights
  // the keyboard-tracked composer. The header still owns the top inset, which
  // is what keeps the layout flush like the other tabs.
  return <TabStack />;
}
