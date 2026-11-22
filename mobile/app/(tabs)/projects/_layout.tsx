import { Stack } from "expo-router";
import { TabStack } from "@/components/TabStack";

/**
 * Projects tab stack. The project → note/card drill-down lives INSIDE this tab
 * stack (not the root stack) so the native tab bar stays visible while browsing
 * a project, and re-tapping the Projects tab pops back to the project list.
 *
 * Only the list (`index`) gets a large title; the pushed detail screens use
 * regular titles with a back button, matching iOS drill-down convention.
 */
export default function ProjectsLayout() {
  return (
    <TabStack>
      <Stack.Screen name="index" options={{ title: "Projects" }} />
      <Stack.Screen name="project/[id]" options={{ title: "Project" }} />
      <Stack.Screen name="project/calendar" options={{ title: "Calendar" }} />
      <Stack.Screen name="note/[id]" options={{ title: "Note" }} />
      <Stack.Screen name="card/[id]" options={{ title: "Task" }} />
    </TabStack>
  );
}
