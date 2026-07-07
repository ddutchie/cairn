import { useCallback, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { getKnowledgeGraph, type KnowledgeGraph } from "@/db/queries";
import { KnowledgeGraphWebView, type GraphMode } from "@/components/KnowledgeGraphWebView";
import { TabScreen } from "@/components/TabScreen";
import { ICON_GRAPH_FORCE, ICON_GRAPH_RADIAL } from "@/components/toolbar-icons";
import { useDataChanged } from "@/sync/useSyncStatus";
import { useTheme, type as typeScale } from "@/theme";

/**
 * Workspace-wide Knowledge Graph — every project, note, card and tag wired by
 * their explicit links, rendered as a D3 force-directed graph (or a radial
 * hierarchy tree) in an offline WebView. Tapping a node opens the corresponding
 * note/card/project screen.
 *
 * The Force/Radial layout switch lives in the native Stack.Toolbar (right) so
 * the tab reads like the rest of the app; the denser view controls (labels,
 * hulls, search, node-type chips) stay in the in-body toolbar.
 */
export default function GraphScreen() {
  const router = useRouter();
  const t = useTheme();
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [mode, setMode] = useState<GraphMode>("force");

  const load = useCallback(() => setGraph(getKnowledgeGraph()), []);
  useFocusEffect(useCallback(() => load(), [load]));
  useDataChanged(load);

  const onSelectNode = useCallback(
    (node: { id: string; type: string }) => {
      switch (node.type) {
        case "note":
          router.push({ pathname: "/note/[id]", params: { id: node.id, back: "Graph" } });
          break;
        case "card":
          router.push({ pathname: "/card/[id]", params: { id: node.id, back: "Graph" } });
          break;
        case "project":
          router.push({ pathname: "/project/[id]", params: { id: node.id, back: "Graph" } });
          break;
        // tags have no detail screen — ignore.
      }
    },
    [router],
  );

  const isEmpty = graph !== null && graph.nodes.length === 0;

  return (
    <TabScreen>
      <Stack.Screen options={{ title: "Knowledge Graph" }} />
      {!isEmpty ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Menu
            icon={mode === "force" ? ICON_GRAPH_FORCE : ICON_GRAPH_RADIAL}
            accessibilityLabel="Graph layout"
          >
            <Stack.Toolbar.Label>{mode === "force" ? "Force" : "Radial"}</Stack.Toolbar.Label>
            <Stack.Toolbar.MenuAction
              icon={ICON_GRAPH_FORCE}
              isOn={mode === "force"}
              onPress={() => setMode("force")}
            >
              Force
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction
              icon={ICON_GRAPH_RADIAL}
              isOn={mode === "radial"}
              onPress={() => setMode("radial")}
            >
              Radial
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
      ) : null}
      {isEmpty ? (
        <View style={styles.empty}>
          <Text style={[styles.emptyTitle, { color: t.textSecondary }]}>Nothing to graph yet</Text>
          <Text style={[styles.emptyHint, { color: t.textTertiary }]}>
            Create notes and tasks, then link or tag them to see connections here.
          </Text>
        </View>
      ) : graph ? (
        <KnowledgeGraphWebView graph={graph} mode={mode} onModeChange={setMode} onSelectNode={onSelectNode} />
      ) : null}
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  emptyTitle: { ...typeScale.title },
  emptyHint: { ...typeScale.caption, textAlign: "center", marginTop: 8 },
});

