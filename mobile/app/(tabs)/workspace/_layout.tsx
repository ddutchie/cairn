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
      {/* The same screens the root stack presents as modals from Chat and Projects,
          pushed here so opening them from Workspace keeps the tab bar and its header. */}
      <Stack.Screen name="settings" options={{ title: "Settings" }} />
      <Stack.Screen name="usage" options={{ title: "Usage" }} />
      <Stack.Screen name="sync" options={{ title: "Sync" }} />
      <Stack.Screen name="ai" options={{ title: "AI settings" }} />
      <Stack.Screen name="providers" options={{ title: "AI Providers" }} />
      <Stack.Screen name="tools" options={{ title: "Tools & Services" }} />
      <Stack.Screen name="appearance" options={{ title: "Appearance" }} />
    </TabStack>
  );
}
