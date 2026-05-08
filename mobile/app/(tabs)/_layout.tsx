import { Tabs } from "expo-router";
import { useEffect } from "react";
import { useStore } from "../../store/index";

// Tab bar icons using lucide-react-native
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
          backgroundColor: "#18181b",
          borderTopColor: "#27272a",
        },
        tabBarActiveTintColor: "#6366f1",
        tabBarInactiveTintColor: "#71717a",
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Projects",
          tabBarIcon: ({ color, size }) => <LayoutGrid color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="notes"
        options={{
          title: "Notes",
          tabBarIcon: ({ color, size }) => <FileText color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: "AI Chat",
          tabBarIcon: ({ color, size }) => <MessageCircle color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => <Settings color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}
