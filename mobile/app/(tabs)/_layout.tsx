import { Tabs } from "expo-router";

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: true }}>
      <Tabs.Screen name="index" options={{ title: "Notes" }} />
      <Tabs.Screen name="board" options={{ title: "Board" }} />
      <Tabs.Screen name="search" options={{ title: "Search" }} />
      <Tabs.Screen name="sync" options={{ title: "Sync" }} />
    </Tabs>
  );
}
