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
      <Stack.Screen name="graph" options={{ headerLargeTitle: false, title: "Knowledge Graph" }} />
      {/* The same screens the root stack presents as modals from Chat and Projects,
          pushed here so opening them from Workspace keeps the tab bar and its header. */}
      <Stack.Screen name="usage" options={{ headerLargeTitle: false, title: "Usage" }} />
      <Stack.Screen name="sync" options={{ headerLargeTitle: false, title: "Sync" }} />
      <Stack.Screen name="ai" options={{ headerLargeTitle: false, title: "AI settings" }} />
      <Stack.Screen name="providers" options={{ headerLargeTitle: false, title: "AI Providers" }} />
      <Stack.Screen name="tools" options={{ headerLargeTitle: false, title: "Tools & Services" }} />
      <Stack.Screen name="appearance" options={{ headerLargeTitle: false, title: "Appearance" }} />
    </TabStack>
  );
}
