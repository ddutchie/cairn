import { TabStack } from "@/components/TabStack";

// The tab's first screen. The tab is a group, so its list is no longer a plain `index` route and
// the stack would not seed it: opening a deeper screen first (a link, the pinned tool) left it as
// the only screen, and re-tapping the tab had nothing to pop back to.
export const unstable_settings = { anchor: "calendar/index" };

// Regular (non-large) title so the fixed calendar grid isn't pushed off-screen
// by an oversized large-title header the way a scroll-driven list tab is.
export default function CalendarLayout() {
  return <TabStack />;
}
