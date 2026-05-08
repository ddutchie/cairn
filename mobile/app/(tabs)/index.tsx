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
      <View style={{
        flexDirection: "row", alignItems: "center",
        paddingHorizontal: 16, paddingVertical: 10,
        borderBottomWidth: 1, borderBottomColor: "#2a2a2a",
      }}>
        <Text style={{ flex: 1, color: "#9e9a94", fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.8 }}>
          Projects
        </Text>
        <Text style={{ color: "#3a3835", fontSize: 11 }}>
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
