import { TabStack } from "@/components/TabStack";

// The tab's first screen. The tab is a group, so its list is no longer a plain `index` route and
// the stack would not seed it: opening a deeper screen first (a link, the pinned tool) left it as
// the only screen, and re-tapping the tab had nothing to pop back to.
export const unstable_settings = { anchor: "search/index" };

// Standard (non-large) header, matching Calendar / Graph / Chat. The native
// search field owns the header area, so a large scrolling title just fights the
// results list and search bar for space.
export default function SearchLayout() {
  return <TabStack />;
}
