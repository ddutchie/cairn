import { TabStack } from "@/components/TabStack";

export default function ChatLayout() {
  // Chat uses a standard (non-large) header — a scrolling large title fights
  // the keyboard-tracked composer. The header still owns the top inset, which
  // is what keeps the layout flush like the other tabs.
  return <TabStack largeTitle={false} />;
}
