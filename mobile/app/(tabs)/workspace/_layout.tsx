import { Stack } from "expo-router";
import { TabStack } from "@/components/TabStack";

/**
 * Workspace tab stack: the home, then People (list, person, team) and the
 * knowledge graph pushed inside it so the tab bar stays visible and back goes to
 * the home. Only the home and the People list get a large title.
 */
export default function WorkspaceLayout() {
  return (
    <TabStack>
      <Stack.Screen name="index" options={{ title: "Workspace" }} />
      <Stack.Screen name="people/index" options={{ title: "People" }} />
      <Stack.Screen name="people/[id]" options={{ headerLargeTitle: false, title: "Person" }} />
      <Stack.Screen name="people/team/[id]" options={{ headerLargeTitle: false, title: "Team" }} />
      <Stack.Screen name="graph" options={{ headerLargeTitle: false, title: "Graph" }} />
    </TabStack>
  );
}
