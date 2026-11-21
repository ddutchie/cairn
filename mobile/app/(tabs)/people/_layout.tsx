import { Stack } from "expo-router";
import { TabStack } from "@/components/TabStack";

/**
 * People tab stack. The list, a person's page and a team's page live INSIDE the
 * tab so the tab bar stays visible; only the list has a large title.
 */
export default function PeopleLayout() {
  return (
    <TabStack>
      <Stack.Screen name="index" options={{ title: "People" }} />
      <Stack.Screen name="[id]" options={{ headerLargeTitle: false, title: "Person" }} />
    </TabStack>
  );
}
