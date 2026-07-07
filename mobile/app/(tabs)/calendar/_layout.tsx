import { TabStack } from "@/components/TabStack";

// Regular (non-large) title so the fixed calendar grid isn't pushed off-screen
// by an oversized large-title header the way a scroll-driven list tab is.
export default function CalendarLayout() {
  return <TabStack largeTitle={false} />;
}
