import { useEffect, useMemo, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { Canvas, Group, Picture, type SkPicture } from "@shopify/react-native-skia";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useDerivedValue, useReducedMotion, useSharedValue } from "react-native-reanimated";
import { useIsFocused } from "expo-router";
import { useTheme } from "@/theme";
import { GraphChrome } from "@/components/graph/GraphChrome";
import { GraphEngine } from "@/graph/engine";
import { useGraphControls, type GraphMode } from "@/graph/useGraphControls";
import type { KnowledgeGraph } from "@/db/queries";
import type { LabelMode } from "@cairn/shared/ui/graph";

/**
 * Knowledge Graph drawn natively with Skia (replaces the D3 WebView): same
 * Force/Radial layouts, chrome and callbacks as KnowledgeGraphWebView. The
 * layout, camera and frame loop live in GraphEngine; this component mounts the
 * canvas, forwards gestures and keeps the transform on the UI thread.
 */
export function KnowledgeGraphSkia({
  graph,
  onSelectNode,
  mode: modeProp,
  onModeChange,
  labelMode: labelModeProp,
  onLabelModeChange,
  showSemantic = false,
  onToggleSemantic,
  semanticAvailable = false,
  semanticLoading = false,
}: {
  graph: KnowledgeGraph;
  onSelectNode?: (node: { id: string; type: string }) => void;
  mode?: GraphMode;
  onModeChange?: (mode: GraphMode) => void;
  labelMode?: LabelMode;
  onLabelModeChange?: (mode: LabelMode) => void;
  showSemantic?: boolean;
  onToggleSemantic?: () => void;
  semanticAvailable?: boolean;
  semanticLoading?: boolean;
}) {
  const t = useTheme();
  const reducedMotion = useReducedMotion();
  const controls = useGraphControls(graph, {
    mode: modeProp, onModeChange, labelMode: labelModeProp, onLabelModeChange,
  });
  const { mode, labelMode, showHulls, filtered } = controls;

  const [picture, setPicture] = useState<SkPicture | null>(null);
  const k = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const transform = useDerivedValue(() => [
    { translateX: tx.get() },
    { translateY: ty.get() },
    { scale: k.get() },
  ]);

  const [engine] = useState(
    () =>
      new GraphEngine(
        {
          onPicture: setPicture,
          onCamera: (c) => {
            k.set(c.k);
            tx.set(c.tx);
            ty.set(c.ty);
          },
        },
        t,
        { mode, labelMode, showHulls, reducedMotion },
      ),
  );

  useEffect(() => {
    engine.onSelectNode = onSelectNode;
  }, [engine, onSelectNode]);
  useEffect(() => engine.setTheme(t), [engine, t]);
  useEffect(
    () => engine.setOptions({ mode, labelMode, showHulls, reducedMotion }),
    [engine, mode, labelMode, showHulls, reducedMotion],
  );
  useEffect(() => engine.setGraph(filtered), [engine, filtered]);

  // Sleep while the tab is hidden or the app is backgrounded.
  const focused = useIsFocused();
  const [appActive, setAppActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setAppActive(s === "active"));
    return () => sub.remove();
  }, []);
  useEffect(() => engine.setActive(focused && appActive), [engine, focused, appActive]);
  useEffect(() => () => engine.dispose(), [engine]);

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .runOnJS(true)
      .maxPointers(1)
      .minDistance(4)
      .onBegin((e) => engine.panBegin(e.x, e.y))
      .onStart(() => engine.panStart())
      .onUpdate((e) => engine.panMove(e.x, e.y, e.translationX, e.translationY))
      .onFinalize(() => engine.panEnd());
    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .onStart((e) => engine.pinchStart(e.focalX, e.focalY))
      .onUpdate((e) => engine.pinchMove(e.scale, e.focalX, e.focalY))
      .onFinalize(() => engine.pinchEnd());
    const tap = Gesture.Tap()
      .runOnJS(true)
      .maxDistance(10)
      .onEnd((e, success) => {
        if (success) engine.tap(e.x, e.y);
      });
    return Gesture.Race(Gesture.Simultaneous(pan, pinch), tap);
  }, [engine]);

  return (
    <GraphChrome
      mode={mode}
      onModeChange={controls.setMode}
      showModeToggle={controls.showModeToggle}
      labelMode={labelMode}
      onLabelModeChange={controls.setLabelMode}
      showLabelPill={controls.showLabelPill}
      showHulls={showHulls}
      onToggleHulls={controls.toggleHulls}
      showSemantic={showSemantic}
      onToggleSemantic={onToggleSemantic}
      semanticAvailable={semanticAvailable}
      semanticLoading={semanticLoading}
      search={controls.search}
      onSearchChange={controls.setSearch}
      activeTypes={controls.activeTypes}
      onToggleType={controls.toggleType}
      nodeCount={filtered.nodes.length}
      edgeCount={filtered.edges.length}
      onFit={() => engine.fitFromUser()}
    >
      <GestureDetector gesture={gesture}>
        <View
          style={styles.canvas}
          onLayout={(e) => engine.setSize(e.nativeEvent.layout.width, e.nativeEvent.layout.height)}
        >
          <Canvas style={StyleSheet.absoluteFill}>
            {picture ? (
              <Group transform={transform}>
                <Picture picture={picture} />
              </Group>
            ) : null}
          </Canvas>
        </View>
      </GestureDetector>
    </GraphChrome>
  );
}

const styles = StyleSheet.create({
  canvas: { flex: 1, backgroundColor: "transparent" },
});
