import { View, Text, ScrollView, Pressable, RefreshControl } from "react-native";
import { useRouter } from "expo-router";
import { useState, useCallback } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { useStore } from "../../store/index";
import { ProjectCard } from "../../components/ProjectCard";

export default function ProjectsTab() {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  const workspaceId = useStore((s) => s.activeWorkspaceId);
  const projects = useStore((s) => s.projects);
  const loadProjects = useStore((s) => s.loadProjects);
  const setActiveProject = useStore((s) => s.setActiveProject);

  const onRefresh = useCallback(async () => {
    if (!workspaceId) return;
    setRefreshing(true);
    await loadProjects(workspaceId);
    setRefreshing(false);
  }, [workspaceId]);

  const active = projects.filter((p) => p.status !== "archived");

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#0d0d0d" }} edges={["top"]}>
      {/* Header */}
      <View style={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 }}>
        <Text style={{ color: "#e8e4dc", fontSize: 22, fontWeight: "700", letterSpacing: -0.3 }}>
          Projects
        </Text>
        <Text style={{ color: "#66635f", fontSize: 12, marginTop: 2 }}>
          {active.length} active
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 8 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#7c6af7" />}
      >
        {active.length === 0 && (
          <View style={{ alignItems: "center", paddingVertical: 60 }}>
            <Text style={{ color: "#66635f", fontSize: 14 }}>No projects yet.</Text>
          </View>
        )}
        {active.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            onPress={() => { setActiveProject(p.id); router.push(`/project/${p.id}`); }}
          />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
