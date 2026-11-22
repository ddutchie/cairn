import { Stack } from "expo-router";
import { TabStack } from "@/components/TabStack";

/**
 * Workspace tab stack: the home, then People (list, person, team) and the
 * knowledge graph pushed inside it so the tab bar stays visible and back goes to
 * the home. Every title is inline, like the other tabs.
 */
export default function WorkspaceLayout() {
  return (
    <TabStack>
      <Stack.Screen name="index" options={{ title: "Workspace" }} />
      <Stack.Screen name="people/index" options={{ title: "People" }} />
      <Stack.Screen name="people/[id]" options={{ title: "Person" }} />
      <Stack.Screen name="people/team/[id]" options={{ title: "Team" }} />
      <Stack.Screen name="graph" options={{ title: "Knowledge Graph" }} />
      <Stack.Screen name="usage" options={{ title: "Usage" }} />
    </TabStack>
  );
}
