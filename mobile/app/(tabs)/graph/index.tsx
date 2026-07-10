import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { Stack, useRouter } from "expo-router";
import { getKnowledgeGraph, listWorkspaceIds, type KnowledgeGraph, type GraphEdge } from "@/db/queries";
import type { GraphMode } from "@/components/KnowledgeGraphWebView";
import type { LabelMode } from "@cairn/shared/ui/graph";
import { TabScreen } from "@/components/TabScreen";
import { EmptyState } from "@/components/EmptyState";
import { ICON_GRAPH_FORCE, ICON_GRAPH_RADIAL, ICON_LABELS, ICON_LABELS_SMART, ICON_LABELS_ALL, ICON_LABELS_MINIMAL } from "@/components/toolbar-icons";
import { toolbarPress } from "@/haptics";
import { useRefreshOnFocus, useDataChanged } from "@/sync/useSyncStatus";
import { semanticEdges } from "@/notes/embeddings";
import { isAppleEmbeddingsSupported } from "@modules/apple-embeddings";
import { useTheme } from "@/theme";

// The graph WebView inlines the full D3 bundle (~274 KB) as a string. Load it
// lazily so opening the app / other tabs never evaluates that module — only the
// Graph tab, on first view, pays the cost.
const KnowledgeGraphWebView = lazy(() =>
  import("@/components/KnowledgeGraphWebView").then((m) => ({ default: m.KnowledgeGraphWebView })),
);

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
  const [labelMode, setLabelMode] = useState<LabelMode>("smart");
  // On-device semantic edges (dashed accent links), loaded lazily and merged
  // only when the toggle is on. Off by default so the graph opens showing the
  // explicit/structural links first (matches desktop, where the semantic
  // threshold defaults to "off").
  const [showSemantic, setShowSemantic] = useState(false);
  const [semantic, setSemantic] = useState<GraphEdge[]>([]);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const semanticAvailable = isAppleEmbeddingsSupported();
  // Monotonic token so a slow semantic load can't overwrite a newer one (e.g.
  // the toggle flips or data changes mid-load).
  const semanticSeq = useRef(0);

  const load = useCallback(() => setGraph(getKnowledgeGraph()), []);
  useRefreshOnFocus(load);

  // Compute semantic edges when the toggle is switched on, and refresh when the
  // underlying data changes while it's on. Cheap no-op when unavailable.
  const loadSemantic = useCallback(async () => {
    const seq = ++semanticSeq.current;
    if (!showSemantic || !semanticAvailable) {
      setSemantic([]);
      setSemanticLoading(false);
      return;
    }
    setSemanticLoading(true);
    // Yield a frame so the spinner actually paints before the on-device
    // embedding pass (synchronous CPU work) blocks the JS thread — otherwise
    // React batches the loading:true with the eventual loading:false and the
    // spinner never renders.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    if (seq !== semanticSeq.current) return; // superseded during the yield
    try {
      const all: GraphEdge[] = [];
      for (const ws of listWorkspaceIds()) {
        const edges = await semanticEdges(ws);
        for (const e of edges) all.push({ source: e.source, target: e.target, type: "semantic", weight: e.weight });
      }
      // Ignore if a newer load started (toggle flipped / data changed) meanwhile.
      if (seq === semanticSeq.current) setSemantic(all);
    } catch (err) {
      console.warn("[graph] semantic edges failed:", err);
    } finally {
      // Only clear the spinner if we're still the latest load.
      if (seq === semanticSeq.current) setSemanticLoading(false);
    }
  }, [showSemantic, semanticAvailable]);
  // Recompute whenever the toggle flips (loadSemantic changes with showSemantic).
  // This is the primary trigger — the spinner shows the moment the pill is tapped.
  // setState inside loadSemantic is intentional: this effect kicks off an async
  // load and reflects its lifecycle (loading → result) into state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadSemantic(); }, [loadSemantic]);
  // Also recompute when inbound sync changes the underlying notes while it's on.
  useDataChanged(useCallback(() => { void loadSemantic(); }, [loadSemantic]));

  // Merge structural + semantic edges, keeping only semantic edges whose both
  // endpoints exist as nodes in the current graph.
  const mergedGraph = useMemo<KnowledgeGraph | null>(() => {
    if (!graph) return null;
    if (!showSemantic || semantic.length === 0) return graph;
    const ids = new Set(graph.nodes.map((n) => n.id));
    const extra = semantic.filter((e) => ids.has(e.source) && ids.has(e.target));
    return { nodes: graph.nodes, edges: [...graph.edges, ...extra] };
  }, [graph, semantic, showSemantic]);

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
        <>
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.Menu
              icon={mode === "force" ? ICON_GRAPH_FORCE : ICON_GRAPH_RADIAL}
              accessibilityLabel="Graph layout"
            >
              <Stack.Toolbar.Label>{mode === "force" ? "Force" : "Radial"}</Stack.Toolbar.Label>
              <Stack.Toolbar.MenuAction
                icon={ICON_GRAPH_FORCE}
                isOn={mode === "force"}
                onPress={toolbarPress(() => setMode("force"))}
              >
                Force
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction
                icon={ICON_GRAPH_RADIAL}
                isOn={mode === "radial"}
                onPress={toolbarPress(() => setMode("radial"))}
              >
                Radial
              </Stack.Toolbar.MenuAction>
            </Stack.Toolbar.Menu>
          </Stack.Toolbar>
          {/* Label-density menu (force only — radial drills in, no label modes). */}
          {mode === "force" ? (
            <Stack.Toolbar placement="left">
              <Stack.Toolbar.Menu icon={ICON_LABELS} accessibilityLabel="Label density">
                <Stack.Toolbar.Label>{`${labelMode} labels`}</Stack.Toolbar.Label>
                <Stack.Toolbar.MenuAction icon={ICON_LABELS_SMART} isOn={labelMode === "smart"} onPress={toolbarPress(() => setLabelMode("smart"))}>
                  Smart
                </Stack.Toolbar.MenuAction>
                <Stack.Toolbar.MenuAction icon={ICON_LABELS_ALL} isOn={labelMode === "all"} onPress={toolbarPress(() => setLabelMode("all"))}>
                  All
                </Stack.Toolbar.MenuAction>
                <Stack.Toolbar.MenuAction icon={ICON_LABELS_MINIMAL} isOn={labelMode === "minimal"} onPress={toolbarPress(() => setLabelMode("minimal"))}>
                  Minimal
                </Stack.Toolbar.MenuAction>
              </Stack.Toolbar.Menu>
            </Stack.Toolbar>
          ) : null}
        </>
      ) : null}
      {isEmpty ? (
        <EmptyState
          title="Nothing to graph yet"
          subtitle="Create notes and tasks, then link or tag them to see connections here."
        />
      ) : graph ? (
        <Suspense fallback={<View style={styles.empty}><ActivityIndicator color={t.textTertiary} /></View>}>
          <KnowledgeGraphWebView
            graph={mergedGraph ?? graph}
            mode={mode}
            onModeChange={setMode}
            labelMode={labelMode}
            onLabelModeChange={setLabelMode}
            showSemantic={showSemantic}
            onToggleSemantic={() => setShowSemantic((v) => !v)}
            semanticAvailable={semanticAvailable}
            semanticLoading={semanticLoading}
            onSelectNode={onSelectNode}
          />
        </Suspense>
      ) : null}
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
});

