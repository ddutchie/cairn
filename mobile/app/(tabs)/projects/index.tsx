import { useCallback, useState } from "react";
import { View, Text, FlatList, StyleSheet, RefreshControl } from "react-native";
import { Stack, useRouter } from "expo-router";
import { listProjectSummaries, type ProjectSummary } from "@/db/queries";
import { getActiveSourceName } from "@/db";
import { PressableScale } from "@/components/PressableScale";
import { TabScreen } from "@/components/TabScreen";
import { EmptyState } from "@/components/EmptyState";
import { SkeletonList } from "@/components/Skeleton";
import { ProjectIcon } from "@/components/ProjectIcon";
import { useSyncBadge } from "@/components/SyncStatusBadge";
import { WorkspaceHeaderMenu } from "@/components/WorkspaceHeaderMenu";
import { ICON_SETTINGS } from "@/components/toolbar-icons";
import { haptics, toolbarPress } from "@/haptics";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { requestSync } from "@/sync/controller";
import { useTheme, elevation, type as typeScale } from "@/theme";

export default function ProjectsScreen() {
  const router = useRouter();
  const t = useTheme();
  const syncBadge = useSyncBadge();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  // The active workspace name doubles as the header title; it changes when the
  // user switches workspace from the header-left menu, so track it in state and
  // refresh it on focus / data change alongside the project list.
  const [workspaceName, setWorkspaceName] = useState<string | null>(() => getActiveSourceName());
  // Distinguish "still loading the first read" from "genuinely no projects" so
  // we show a skeleton instead of the empty state on cold start.
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    setProjects(listProjectSummaries());
    setWorkspaceName(getActiveSourceName());
    setLoaded(true);
  }, []);
  useRefreshOnFocus(load);
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    haptics.selection();
    try {
      await requestSync("pull-to-refresh");
    } catch {}
    load();
    setTimeout(() => setRefreshing(false), 400);
  }, [load]);

  const header = (
    <>
      <Stack.Screen options={{ title: workspaceName ?? "Projects" }} />
      <WorkspaceHeaderMenu />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button {...syncBadge} />
        <Stack.Toolbar.Button
          icon={ICON_SETTINGS}
          accessibilityLabel="Appearance settings"
          onPress={toolbarPress(() => router.push("/settings/appearance"))}
        />
      </Stack.Toolbar>
    </>
  );

  if (!loaded) {
    return (
      <TabScreen>
        {header}
        <SkeletonList count={6} />
      </TabScreen>
    );
  }

  if (projects.length === 0) {
    return (
      <TabScreen>
        {header}
        <EmptyState
          title="No projects yet"
          subtitle="Connect your sync folder in the Sync tab to pull your workspace."
        />
      </TabScreen>
    );
  }

  return (
    <TabScreen>
      {header}
      <FlatList
        data={projects}
        keyExtractor={(p) => p.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.textTertiary} />}
        contentContainerStyle={styles.list}
        contentInsetAdjustmentBehavior="automatic"
        renderItem={({ item }) => (
          <PressableScale
            style={[styles.row, { backgroundColor: t.surface, borderColor: t.border }, elevation.sm]}
            onPress={() => router.push({ pathname: "/projects/project/[id]", params: { id: item.id } })}
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
          </PressableScale>
        )}
      />
    </TabScreen>
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
  name: { ...typeScale.subtitle },
  meta: { ...typeScale.caption, marginTop: 2 },
  chevron: { fontSize: 22, fontWeight: "300" },
});
