import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import {
  Circle,
  GitBranch,
  Hexagon,
  Type,
  ChevronDown,
  Network,
  Maximize2,
} from "lucide-react-native";
import { useTheme, useIsDark, withAlpha, type as typeScale, iconSize, type Theme } from "@/theme";
import { haptics } from "@/haptics";
import { SearchField } from "@/components/SearchField";
import { buildGraphHtml } from "@/components/graph/graph-webview-html";
import type { KnowledgeGraph, GraphNodeType } from "@/db/queries";
import {
  nodeTypeToken,
  nodeRadius,
  edgeStyle,
  chargeStrength,
  linkDistance,
  collideRadius,
  anchorStrength,
  CLUSTER_RADIUS,
  LINK_STRENGTH,
  COLLIDE_ITERATIONS,
  ALPHA_DECAY,
  VELOCITY_DECAY,
  labelScreenPx,
  labelMaxLen,
  buildHierarchy,
  sunburstTypeToken,
  type ThemeToken,
  type LabelMode,
  type HierarchyNode,
} from "@cairn/shared/ui/graph";

const ALL_NODE_TYPES: GraphNodeType[] = ["project", "note", "card", "tag"];
const LABEL_MODES: LabelMode[] = ["smart", "all", "minimal"];
export type GraphMode = "force" | "radial";

/** Resolve a shared graph theme token to a concrete colour on this platform. */
function tokenColor(token: ThemeToken, t: Theme): string {
  switch (token) {
    case "accent": return t.accent;
    case "info": return t.info;
    case "success": return t.success;
    case "warning": return t.warning;
    case "border": return t.border;
    case "background": return t.background;
    case "textPrimary": return t.textPrimary;
    case "textSecondary": return t.textSecondary;
    case "textTertiary": return t.textTertiary;
  }
}

/** Node type → colour, via the shared token map (tags = warning, NOT tag colour). */
function nodeTypeColor(type: GraphNodeType, t: Theme): string {
  return tokenColor(nodeTypeToken(type), t);
}

/**
 * Full-screen interactive Knowledge Graph rendered with D3 inside an offline
 * WebView (D3 is bundled, no network). Mirrors the desktop KnowledgeGraphView:
 *   • a Force-directed layout (shared node colours/radii/forces + cluster hulls)
 *   • a Radial hierarchy tree (sunburst that drills in: workspace → projects →
 *     notes/cards, plus a Tags branch)
 * and the desktop toolbar chrome — a Force/Radial toggle, a label-mode dropdown,
 * a Hulls toggle, a search box and node-type filter chips.
 *
 * Tapping a node posts its id back so the host can navigate to the note/card/
 * project.
 */
export function KnowledgeGraphWebView({
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
  /** Controlled layout mode. When provided the in-body Force/Radial segment is
   *  hidden and the parent (native toolbar) drives it. */
  mode?: GraphMode;
  onModeChange?: (mode: GraphMode) => void;
  /** Controlled label mode. When provided the in-body labels pill is hidden and
   *  the parent (native left toolbar menu) drives it. */
  labelMode?: LabelMode;
  onLabelModeChange?: (mode: LabelMode) => void;
  /** Semantic-links toggle (force mode only). Rendered as an in-body pill left
   *  of the Hulls toggle when `semanticAvailable`. */
  showSemantic?: boolean;
  onToggleSemantic?: () => void;
  semanticAvailable?: boolean;
  /** True while semantic edges are being (re)computed — shows a spinner in the
   *  pill, since the on-device pass can take a second or two. */
  semanticLoading?: boolean;
}) {
  const t = useTheme();
  const isDark = useIsDark();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(t), [t]);
  const ref = useRef<WebView>(null);

  const [modeInternal, setModeInternal] = useState<GraphMode>("force");
  const mode = modeProp ?? modeInternal;
  const setMode = (m: GraphMode) => {
    if (onModeChange) onModeChange(m);
    else setModeInternal(m);
  };
  const [activeTypes, setActiveTypes] = useState<Set<GraphNodeType>>(
    () => new Set(ALL_NODE_TYPES),
  );
  const [showHulls, setShowHulls] = useState(true);
  const [labelModeInternal, setLabelModeInternal] = useState<LabelMode>("smart");
  const labelMode = labelModeProp ?? labelModeInternal;
  const setLabelMode = (m: LabelMode) => {
    if (onLabelModeChange) onLabelModeChange(m);
    else setLabelModeInternal(m);
  };
  const [labelOpen, setLabelOpen] = useState(false);
  const [labelAnchorX, setLabelAnchorX] = useState(116);
  const [search, setSearch] = useState("");

  // Node-type filter, then a search filter (title / tag name), then drop edges
  // whose endpoints were removed. Search keeps parent projects of matches so the
  // radial hierarchy still has a bucket for them (mirrors desktop searchedGraph).
  const filtered = useMemo(() => {
    let nodes = graph.nodes.filter((n) => activeTypes.has(n.type));
    const q = search.trim().toLowerCase();
    if (q) {
      const tagName = new Map<string, string>();
      for (const n of nodes) if (n.type === "tag") tagName.set(n.id, n.title.toLowerCase());
      const nodeTags = new Map<string, string[]>();
      for (const e of graph.edges) {
        if (e.type !== "tag-member") continue;
        (nodeTags.get(e.source) ?? nodeTags.set(e.source, []).get(e.source)!).push(e.target);
      }
      const match = new Set(
        nodes
          .filter((n) => {
            if (n.title.toLowerCase().includes(q)) return true;
            return (nodeTags.get(n.id) ?? []).some((tid) => tagName.get(tid)?.includes(q));
          })
          .map((n) => n.id),
      );
      const keepProjects = new Set<string>();
      for (const n of nodes) if (match.has(n.id) && n.projectId) keepProjects.add(n.projectId);
      nodes = nodes.filter((n) => match.has(n.id) || (n.type === "project" && keepProjects.has(n.id)));
    }
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    return { nodes, edges };
  }, [graph, activeTypes, search]);

  // Link visual payload — derived from the current edges. Extracted so both the
  // initial HTML and the in-place window.__update() injection shape links
  // identically. Depends only on edges + theme (semantic toggle changes edges).
  const linksPayload = useMemo(
    () =>
      filtered.edges.map((e) => {
        const s = edgeStyle(e.type);
        // Semantic edges scale with similarity (0.5 + weight) so stronger
        // matches read bolder; all others are a uniform hairline. (Mobile has
        // no wikilink edges — those exist only on desktop.)
        let width = 1;
        if (e.type === "semantic" && (e.weight ?? 1) < 1) width = 0.5 + (e.weight ?? 0);
        return {
          source: e.source,
          target: e.target,
          color: tokenColor(s.token, t),
          opacity: s.opacity,
          dash: s.dash,
          width,
          distance: linkDistance(e.type),
        };
      }),
    [filtered.edges, t],
  );

  // Structural key: the HTML is rebuilt (full reload) ONLY when the node set,
  // layout mode, or theme changes. showHulls / labelMode / links ARE read inside
  // the html memo (so the initial paint is correct) but are intentionally left
  // out of its dep array — subsequent changes to them are pushed via
  // window.__update() instead of regenerating `source`.
  const structuralKey = useMemo(
    () => `${mode}|${isDark}|${filtered.nodes.map((n) => n.id).join(",")}`,
    [mode, isDark, filtered.nodes],
  );

  const html = useMemo(() => {
    // ── force layout data ──
    const degree = new Map<string, number>();
    for (const e of filtered.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const projectIds = filtered.nodes.filter((n) => n.type === "project").map((n) => n.id);
    const projIndex = new Map(projectIds.map((id, i) => [id, i]));
    const anchorFor = (n: (typeof filtered.nodes)[number]): { x: number; y: number } | null => {
      const pid = n.type === "project" ? n.id : n.projectId;
      if (!pid || !projIndex.has(pid)) return null;
      const i = projIndex.get(pid)!;
      const k = Math.max(1, projectIds.length);
      const ang = (i / k) * 2 * Math.PI;
      return { x: Math.cos(ang) * CLUSTER_RADIUS, y: Math.sin(ang) * CLUSTER_RADIUS };
    };

    // ── radial (sunburst) hierarchy, with per-node resolved colours ──
    const hierarchy = buildHierarchy({ nodes: filtered.nodes });
    const colorHierarchy = (h: HierarchyNode): unknown => ({
      id: h.id,
      title: h.title,
      type: h.type,
      color: tokenColor(sunburstTypeToken(h.type), t),
      children: h.children?.map(colorHierarchy),
    });

    const payload = JSON.stringify({
      mode,
      nodes: filtered.nodes.map((n) => {
        const anchor = anchorFor(n);
        return {
          id: n.id,
          type: n.type,
          title: n.title,
          projectId: n.projectId,
          color: nodeTypeColor(n.type, t),
          r: nodeRadius(n.type),
          charge: chargeStrength(n.type, degree.get(n.id) ?? 0),
          anchorX: anchor?.x ?? 0,
          anchorY: anchor?.y ?? 0,
          anchorStrength: anchorStrength(n.type, !!(n.type === "project" || n.projectId)),
          collideR: collideRadius(n.type),
          labelPx: labelScreenPx(n.type),
          labelMax: labelMaxLen(n.type, false),
          isProject: n.type === "project",
        };
      }),
      links: linksPayload,
      hierarchy: colorHierarchy(hierarchy),
      showHulls,
      labelMode,
      forces: {
        linkStrength: LINK_STRENGTH,
        collideIterations: COLLIDE_ITERATIONS,
        alphaDecay: ALPHA_DECAY,
        velocityDecay: VELOCITY_DECAY,
      },
      theme: {
        bg: t.background,
        surface: t.surface,
        border: t.border,
        text: t.textPrimary,
        textSecondary: t.textSecondary,
        textTertiary: t.textTertiary,
        accent: t.accent,
        accentFg: t.accentFg,
      },
      dark: isDark,
    }).replace(/<\//g, "<\\/");
    return buildGraphHtml(payload);
    // Rebuild ONLY on structural changes (node set / mode / theme). showHulls,
    // labelMode and links are read from refs and pushed via window.__update()
    // so cheap toggles don't reload the WebView. structuralKey encodes mode +
    // isDark + node ids; `filtered`/`mode` are consistent with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structuralKey, t]);

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as { type: string; id?: string; nodeType?: string };
      if (msg.type === "select" && msg.id) {
        onSelectNode?.({ id: msg.id, type: msg.nodeType ?? "" });
      }
    } catch {
      // ignore malformed messages
    }
  };

  // Zoom-to-fit: ask the WebView to frame all nodes into the viewport. Only
  // meaningful in force mode (radial has its own drill-in navigation).
  const fitToView = () => {
    haptics.selection();
    ref.current?.injectJavaScript("window.__fit && window.__fit(); true;");
  };

  // Push cheap force-mode toggles into the live graph via window.__update()
  // instead of regenerating `source` (which would reload the WebView + restart
  // the simulation). Each effect skips its first run — the initial HTML already
  // reflects the current value — and no-ops in radial mode / on the empty WebView.
  const pushUpdate = useCallback((patch: Record<string, unknown>) => {
    const json = JSON.stringify(patch).replace(/<\//g, "<\\/");
    ref.current?.injectJavaScript(`window.__update && window.__update(${json}); true;`);
  }, []);

  const hullsFirst = useRef(true);
  useEffect(() => {
    if (hullsFirst.current) { hullsFirst.current = false; return; }
    if (mode === "force") pushUpdate({ showHulls });
  }, [showHulls, mode, pushUpdate]);

  const labelFirst = useRef(true);
  useEffect(() => {
    if (labelFirst.current) { labelFirst.current = false; return; }
    if (mode === "force") pushUpdate({ labelMode });
  }, [labelMode, mode, pushUpdate]);

  const linksFirst = useRef(true);
  useEffect(() => {
    if (linksFirst.current) { linksFirst.current = false; return; }
    if (mode === "force") pushUpdate({ links: linksPayload });
  }, [linksPayload, mode, pushUpdate]);

  const toggleType = (type: GraphNodeType) => {
    setActiveTypes((cur) => {
      const next = new Set(cur);
      if (next.has(type)) {
        if (next.size === 1) return cur; // keep at least one active
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  return (
    <View style={[styles.root, { backgroundColor: t.background }]}>
      {/* ── Header line 1: layout toggle · label dropdown · hulls ── */}
      <View style={styles.toolbarRow}>
        {/* Layout mode segmented toggle (Force / Radial). Hidden when the parent
            (native header toolbar) drives the mode. */}
        {!onModeChange ? (
          <View style={styles.segment}>
            {([
              { key: "force" as const, Icon: Circle, label: "Force" },
              { key: "radial" as const, Icon: GitBranch, label: "Radial" },
            ]).map(({ key, Icon, label }, idx) => {
              const active = mode === key;
              return (
                <View key={key} style={styles.segmentPart}>
                  {idx > 0 ? <View style={styles.segmentDivider} /> : null}
                  <Pressable
                    onPress={() => setMode(key)}
                    style={[styles.segmentBtn, active && { backgroundColor: t.accentDim }]}
                  >
                    <Icon size={iconSize.control} color={active ? t.accent : t.textTertiary} />
                    {active ? (
                      <Text style={[styles.segmentLabel, { color: t.accent }]}>{label}</Text>
                    ) : null}
                  </Pressable>
                </View>
              );
            })}
          </View>
        ) : null}

        {/* Label mode dropdown — force only (radial drills in, no label modes).
            Hidden when the parent (native left toolbar menu) drives labelMode. */}
        {mode === "force" && !onLabelModeChange ? (
          <Pressable
            onLayout={(e) => setLabelAnchorX(e.nativeEvent.layout.x)}
            onPress={() => setLabelOpen((v) => !v)}
            style={[styles.pillBtn, { borderColor: t.border }]}
          >
            <Type size={iconSize.control} color={t.textSecondary} />
            <Text style={styles.pillLabel}>{labelMode} labels</Text>
            <ChevronDown size={iconSize.hint} color={t.textSecondary} />
          </Pressable>
        ) : null}

        {/* Semantic-links toggle — force only, left of Hulls, when available.
            Shows a spinner while the on-device semantic pass is computing. */}
        {mode === "force" && semanticAvailable && onToggleSemantic ? (
          <Pressable
            onPress={onToggleSemantic}
            disabled={semanticLoading}
            style={[
              styles.pillBtn,
              showSemantic
                ? { borderColor: "transparent", backgroundColor: t.accentDim }
                : { borderColor: t.border },
            ]}
          >
            {semanticLoading ? (
              <ActivityIndicator size="small" color={showSemantic ? t.accent : t.textTertiary} style={styles.pillSpinner} />
            ) : (
              <Network size={iconSize.control} color={showSemantic ? t.accent : t.textTertiary} />
            )}
            <Text style={[styles.pillLabel, { color: showSemantic ? t.accent : t.textTertiary }]}>
              Semantic
            </Text>
          </Pressable>
        ) : null}

        {/* Cluster hulls toggle — force only */}
        {mode === "force" ? (
          <Pressable
            onPress={() => setShowHulls((v) => !v)}
            style={[
              styles.pillBtn,
              showHulls
                ? { borderColor: "transparent", backgroundColor: t.accentDim }
                : { borderColor: t.border },
            ]}
          >
            <Hexagon size={iconSize.control} color={showHulls ? t.accent : t.textTertiary} />
            <Text style={[styles.pillLabel, { color: showHulls ? t.accent : t.textTertiary }]}>
              Hulls
            </Text>
          </Pressable>
        ) : null}

        <View style={{ flex: 1 }} />
        <Text style={styles.stats}>
          {filtered.nodes.length} · {filtered.edges.length}
        </Text>
      </View>

      {/* ── Header line 2: search · node-type toggles ── */}
      <View style={[styles.toolbarRow, styles.toolbarRow2]}>
        <SearchField value={search} onChangeText={setSearch} containerStyle={{ flex: 1 }} />
        <View style={styles.typeToggles}>
          {ALL_NODE_TYPES.map((type) => {
            const active = activeTypes.has(type);
            const color = nodeTypeColor(type, t);
            return (
              <Pressable
                key={type}
                onPress={() => toggleType(type)}
                style={[
                  styles.typeChip,
                  {
                    backgroundColor: active ? withAlpha(color, 0.16) : "transparent",
                    borderColor: active ? withAlpha(color, 0.4) : t.border,
                  },
                ]}
              >
                <View style={[styles.typeDot, { backgroundColor: active ? color : t.textTertiary }]} />
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Label-mode dropdown menu (overlay) — only when the in-body pill is
          shown (i.e. the parent isn't driving labelMode via the native menu). */}
      {labelOpen && mode === "force" && !onLabelModeChange ? (
        <>
          <Pressable style={styles.dropdownBackdrop} onPress={() => setLabelOpen(false)} />
          <View style={[styles.dropdownMenu, { left: labelAnchorX }]}>
            {LABEL_MODES.map((m) => {
              const active = labelMode === m;
              return (
                <Pressable
                  key={m}
                  onPress={() => {
                    setLabelMode(m);
                    setLabelOpen(false);
                  }}
                  style={[styles.dropdownItem, active && { backgroundColor: t.accentDim }]}
                >
                  <Text
                    style={[
                      styles.dropdownItemText,
                      { color: active ? t.accent : t.textSecondary, fontWeight: active ? "600" : "400" },
                    ]}
                  >
                    {m}
                  </Text>
                  {active ? <View style={[styles.dropdownDot, { backgroundColor: t.accent }]} /> : null}
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}

      <View style={styles.canvasWrap}>
        <WebView
          ref={ref}
          originWhitelist={["*"]}
          source={{ html }}
          style={styles.web}
          onMessage={onMessage}
          onShouldStartLoadWithRequest={(req) =>
            req.url === "about:blank" || req.url.startsWith("data:") || req.navigationType === "other"
          }
          javaScriptEnabled
          setSupportMultipleWindows={false}
          scrollEnabled={false}
          // iOS kills the WKWebView content process when the app is backgrounded
          // under memory pressure, leaving the graph blank (live updates go via
          // injectJavaScript, which silently no-ops on a dead process). Reload to
          // rebuild the D3 document. Android equivalent is onRenderProcessGone.
          onContentProcessDidTerminate={() => ref.current?.reload()}
          onRenderProcessGone={() => ref.current?.reload()}
        />

        {/* Legend + zoom-to-fit — bottom row. Keys are left-aligned, the fit
            button is right-aligned in the same row. Offset by the safe-area
            inset so it clears the home indicator / tab bar. Force only. */}
        {mode === "force" ? (
          <View style={[styles.bottomRow, { bottom: 16 + insets.bottom }]} pointerEvents="box-none">
            <View style={styles.legend}>
              {ALL_NODE_TYPES.filter((type) => activeTypes.has(type)).map((type) => (
                <View key={type} style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: nodeTypeColor(type, t) }]} />
                  <Text style={styles.legendLabel} numberOfLines={1}>{type}</Text>
                </View>
              ))}
            </View>
            <Pressable
              onPress={fitToView}
              style={styles.fitBtn}
              accessibilityLabel="Zoom to fit"
              hitSlop={8}
            >
              <Maximize2 size={iconSize.control} color={t.textSecondary} />
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    root: { flex: 1 },
    toolbarRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 7,
      backgroundColor: t.surface,
    },
    toolbarRow2: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
      paddingTop: 0,
    },
    // Layout segmented toggle
    segment: {
      flexDirection: "row",
      alignItems: "center",
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 8,
      overflow: "hidden",
    },
    segmentPart: { flexDirection: "row", alignItems: "center" },
    segmentDivider: { width: StyleSheet.hairlineWidth, height: 20, backgroundColor: t.border },
    segmentBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 7,
    },
    segmentLabel: { ...typeScale.control },
    // Pill buttons (label dropdown, hulls)
    pillBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 7,
      borderRadius: 8,
      borderWidth: 1,
    },
    pillLabel: { ...typeScale.control, fontWeight: "500", color: t.textSecondary, textTransform: "capitalize" },
    // Constrain the spinner to the icon footprint so the pill doesn't resize
    // when it swaps between the Network icon and the ActivityIndicator.
    pillSpinner: { width: iconSize.control, height: iconSize.control },
    stats: { ...typeScale.caption, color: t.textTertiary, fontVariant: ["tabular-nums"] },
    // Node-type toggles (line 2)
    typeToggles: { flexDirection: "row", alignItems: "center", gap: 6 },
    typeChip: {
      width: 26,
      height: 26,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 13,
      borderWidth: 1,
    },
    typeDot: { width: 9, height: 9, borderRadius: 4.5 },
    // Label-mode dropdown
    dropdownBackdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 10 },
    dropdownMenu: {
      position: "absolute",
      top: 44,
      width: 150,
      zIndex: 11,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.surface,
      paddingVertical: 4,
      shadowColor: "#000",
      shadowOpacity: 0.2,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
    dropdownItem: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    dropdownItemText: { ...typeScale.caption, fontWeight: "400", textTransform: "capitalize" },
    dropdownDot: { width: 6, height: 6, borderRadius: 3 },
    // Canvas + legend
    canvasWrap: { flex: 1 },
    web: { flex: 1, backgroundColor: "transparent" },
    // Bottom overlay row: legend (left) + zoom-to-fit (right).
    bottomRow: {
      position: "absolute",
      left: 16,
      right: 16,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    legend: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: withAlpha(t.surface, 0.9),
      flexShrink: 1,
    },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 },
    legendDot: { width: 10, height: 10, borderRadius: 5 },
    legendLabel: { fontSize: 11, color: t.textTertiary, textTransform: "capitalize" },
    fitBtn: {
      width: 40,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: withAlpha(t.surface, 0.9),
      flexShrink: 0,
    },
  });
}
