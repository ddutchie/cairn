import { Tabs } from "expo-router";
import { useEffect } from "react";
import { useStore } from "../../store/index";
import { LayoutGrid, FileText, MessageCircle, Settings } from "lucide-react-native";

export default function TabsLayout() {
  const workspaceId = useStore((s) => s.activeWorkspaceId);
  const loadProjects = useStore((s) => s.loadProjects);

  useEffect(() => {
    if (workspaceId) loadProjects(workspaceId);
  }, [workspaceId]);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: "#141414",
          borderTopColor: "#2a2a2a",
          borderTopWidth: 1,
          paddingBottom: 4,
          height: 58,
        },
        tabBarActiveTintColor: "#7c6af7",
        tabBarInactiveTintColor: "#66635f",
        tabBarLabelStyle: { fontSize: 10, fontWeight: "500", marginTop: -2 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: "Projects", tabBarIcon: ({ color, size }) => <LayoutGrid color={color} size={size - 2} /> }}
      />
      <Tabs.Screen
        name="notes"
        options={{ title: "Notes", tabBarIcon: ({ color, size }) => <FileText color={color} size={size - 2} /> }}
      />
      <Tabs.Screen
        name="chat"
        options={{ title: "AI Chat", tabBarIcon: ({ color, size }) => <MessageCircle color={color} size={size - 2} /> }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: "Settings", tabBarIcon: ({ color, size }) => <Settings color={color} size={size - 2} /> }}
      />
    </Tabs>
  );
}
