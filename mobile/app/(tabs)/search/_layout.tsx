import { TabStack } from "@/components/TabStack";

// Standard (non-large) header, matching Calendar / Graph / Chat. The native
// search field owns the header area, so a large scrolling title just fights the
// results list and search bar for space.
export default function SearchLayout() {
  return <TabStack largeTitle={false} />;
}
