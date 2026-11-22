import { Stack } from "expo-router";
import { TabStack } from "@/components/TabStack";

// The tab's first screen. The tab is a group, so its list is no longer a plain `index` route and
// the stack would not seed it: opening a deeper screen first (a link, the pinned tool) left it as
// the only screen, and re-tapping the tab had nothing to pop back to.
export const unstable_settings = { anchor: "projects/index" };

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
      <Stack.Screen name="projects/index" options={{ title: "Projects" }} />
    </TabStack>
  );
}
