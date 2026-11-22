import { Stack } from "expo-router";
import { TabStack } from "@/components/TabStack";

// The tab's first screen. The tab is a group, so its list is no longer a plain `index` route and
// the stack would not seed it: opening a deeper screen first (a link, the pinned tool) left it as
// the only screen, and re-tapping the tab had nothing to pop back to.
export const unstable_settings = { anchor: "workspace/index" };

/**
 * Workspace tab stack: the home, then People (list, person, team) and the
 * knowledge graph pushed inside it so the tab bar stays visible and back goes to
 * the home. Every title is inline, like the other tabs.
 */
export default function WorkspaceLayout() {
  return (
    <TabStack>
      <Stack.Screen name="workspace/index" options={{ title: "Workspace" }} />
      <Stack.Screen name="workspace/today" options={{ title: "Today" }} />
      <Stack.Screen name="workspace/people/index" options={{ title: "People" }} />
      <Stack.Screen name="workspace/people/[id]" options={{ title: "Person" }} />
      <Stack.Screen name="workspace/people/team/[id]" options={{ title: "Team" }} />
      <Stack.Screen name="workspace/graph" options={{ title: "Knowledge Graph" }} />
      <Stack.Screen name="workspace/usage" options={{ title: "Usage" }} />
    </TabStack>
  );
}
