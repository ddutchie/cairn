import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { Stack, useRouter } from "expo-router";
import { getKnowledgeGraph, listWorkspaceIds, type KnowledgeGraph, type GraphEdge } from "@/db/queries";
import type { GraphMode } from "@/graph/useGraphControls";
import { GRAPH_RENDERER } from "@/graph/renderer";
import type { LabelMode } from "@cairn/shared/ui/graph";
import { TabScreen } from "@/components/TabScreen";
import { EmptyState } from "@/components/EmptyState";
import { ICON_GRAPH_FORCE, ICON_GRAPH_RADIAL, ICON_LABELS, ICON_LABELS_SMART, ICON_LABELS_ALL, ICON_LABELS_MINIMAL } from "@/components/toolbar-icons";
import { toolbarPress } from "@/haptics";
import { useRefreshOnFocus, useDataChanged } from "@/sync/useSyncStatus";
import { semanticEdges } from "@/notes/embeddings";
import { isAppleEmbeddingsSupported } from "@modules/apple-embeddings";
import { useTheme } from "@/theme";
import { SidePreviewLayout, useSidePreview } from "@/components/SidePreview";
import { railToolbar, useTightSideRail } from "@/components/screen-chrome";

// Skia is the default renderer. The legacy D3 WebView inlines the full D3
// bundle (~274 KB) as a string, so both are loaded lazily: opening the app or
// other tabs never evaluates either module, only the Graph tab on first view.
const KnowledgeGraphView = lazy(() =>
  GRAPH_RENDERER === "webview"
    ? import("@/components/KnowledgeGraphWebView").then((m) => ({ default: m.KnowledgeGraphWebView }))
    : import("@/components/KnowledgeGraphSkia").then((m) => ({ default: m.KnowledgeGraphSkia })),
);

/**
 * Workspace-wide Knowledge Graph — every project, note, card and tag wired by
 * their explicit links, rendered natively with Skia as a force-directed graph
 * (or a radial hierarchy tree). Tapping a node opens the corresponding
 * note/card/project screen.
 *
 * The Force/Radial layout switch lives in the native Stack.Toolbar (right) so
 * the tab reads like the rest of the app; the denser view controls (labels,
 * hulls, search, node-type chips) stay in the in-body toolbar.
 */
export default function GraphScreen() {
  const router = useRouter();
  const t = useTheme();
  const tightRail = useTightSideRail();
  // Wide windows open a picked note/task beside the graph (shared with Chat/Calendar).
  // No title beside the canvas when wide (like Chat) — the layout + label
  // controls dock into the side rail instead.
  const sp = useSidePreview({ title: "Knowledge Graph", titleWhenWide: false });
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

  const openPreview = sp.open;
  const onSelectNode = useCallback(
    (node: { id: string; type: string }) => {
      switch (node.type) {
        case "note":
          if (openPreview) openPreview({ kind: "note", id: node.id });
          else router.push({ pathname: "/note/[id]", params: { id: node.id, back: "Graph" } });
          break;
        case "card":
          if (openPreview) openPreview({ kind: "card", id: node.id });
          else router.push({ pathname: "/card/[id]", params: { id: node.id, back: "Graph" } });
          break;
        case "project":
          if (openPreview) openPreview({ kind: "project", id: node.id });
          else router.push({ pathname: "/project/[id]", params: { id: node.id, back: "Graph" } });
          break;
        // tags have no detail screen — ignore.
      }
    },
    [router, openPreview],
  );

  const isEmpty = graph !== null && graph.nodes.length === 0;

  return (
    <TabScreen>
      <Stack.Screen options={sp.screenOptions} />
      {!isEmpty && sp.showToolbar ? (
        <Stack.Toolbar placement="right">
          {railToolbar(
            tightRail,
            <Stack.Toolbar.Menu
              key="layout"
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
            </Stack.Toolbar.Menu>,
            /* Label-density menu (force only — radial drills in, no label modes).
               Same rail as the layout menu: nothing docks left on Duo. */
            mode === "force" ? (
              <Stack.Toolbar.Menu key="labels" icon={ICON_LABELS} accessibilityLabel="Label density">
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
            ) : null,
          )}
        </Stack.Toolbar>
      ) : null}
      <SidePreviewLayout state={sp} onChanged={load} bodyStyle={{ backgroundColor: t.background }}>
      {isEmpty ? (
        <EmptyState
          title="Nothing to graph yet"
          subtitle="Create notes and tasks, then link or tag them to see connections here."
        />
      ) : graph ? (
        <Suspense fallback={<View style={styles.empty}><ActivityIndicator color={t.textTertiary} /></View>}>
          <KnowledgeGraphView
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
      </SidePreviewLayout>
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
});

