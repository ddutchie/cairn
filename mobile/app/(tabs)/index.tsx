import { useCallback, useState } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, RefreshControl } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { listProjectSummaries, type ProjectSummary } from "@/db/queries";
import { Screen } from "@/components/Screen";
import { ProjectIcon } from "@/components/ProjectIcon";
import { SyncStatusBadge } from "@/components/SyncStatusBadge";
import { useTheme } from "@/theme";

export default function ProjectsScreen() {
  const router = useRouter();
  const t = useTheme();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  const load = useCallback(() => setProjects(listProjectSummaries()), []);
  useFocusEffect(useCallback(() => load(), [load]));

  if (projects.length === 0) {
    return (
      <Screen title="Projects" right={<SyncStatusBadge />}>
        <View style={styles.empty}>
          <Text style={[styles.emptyTitle, { color: t.textSecondary }]}>No projects yet</Text>
          <Text style={[styles.emptyHint, { color: t.textTertiary }]}>
            Connect your sync folder in the Sync tab to pull your workspace.
          </Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen title="Projects" right={<SyncStatusBadge />}>
      <FlatList
        data={projects}
        keyExtractor={(p) => p.id}
        refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={t.textTertiary} />}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable
            style={[styles.row, { backgroundColor: t.surface, borderColor: t.border }]}
            onPress={() => router.push(`/project/${item.id}`)}
          >
            <View style={[styles.iconWrap, { backgroundColor: t.accentDim }]}>
              <ProjectIcon name={item.icon} size={18} color={t.accent} />
            </View>
            <View style={styles.rowBody}>
              <Text style={[styles.name, { color: t.textPrimary }]} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={[styles.meta, { color: t.textTertiary }]}>
                {item.noteCount} {item.noteCount === 1 ? "note" : "notes"} · {item.cardCount}{" "}
                {item.cardCount === 1 ? "task" : "tasks"}
              </Text>
            </View>
            <Text style={[styles.chevron, { color: t.textTertiary }]}>›</Text>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { padding: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
    borderRadius: 12,
    borderWidth: 1,
  },
  iconWrap: { width: 38, height: 38, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  rowBody: { flex: 1 },
  name: { fontSize: 16, fontWeight: "600" },
  meta: { fontSize: 12, marginTop: 2 },
  chevron: { fontSize: 22, fontWeight: "300" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  emptyTitle: { fontSize: 17, fontWeight: "600" },
  emptyHint: { fontSize: 13, textAlign: "center", marginTop: 8 },
});
