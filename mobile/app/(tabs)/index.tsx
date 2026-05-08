/**
 * Projects tab — lists all projects in the active workspace.
 */
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

  const activeProjects = projects.filter((p) => p.status !== "archived");

  return (
    <SafeAreaView className="flex-1 bg-zinc-950" edges={["top"]}>
      {/* Header */}
      <View className="px-5 pt-4 pb-3">
        <Text className="text-white text-2xl font-bold tracking-tight">Projects</Text>
        <Text className="text-zinc-500 text-sm mt-0.5">
          {activeProjects.length} project{activeProjects.length !== 1 ? "s" : ""}
        </Text>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="px-5 pb-8 gap-3"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#6366f1" />
        }
      >
        {activeProjects.length === 0 && (
          <View className="items-center py-16">
            <Text className="text-zinc-600 text-base">No projects found.</Text>
            <Text className="text-zinc-700 text-sm mt-1">
              Open a workspace on desktop first.
            </Text>
          </View>
        )}
        {activeProjects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            onPress={() => {
              setActiveProject(project.id);
              router.push(`/project/${project.id}`);
            }}
          />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
