import { useMemo, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import {
  Circle,
  GitBranch,
  Hexagon,
  Type,
  ChevronDown,
} from "lucide-react-native";
import { useTheme, useIsDark, withAlpha, type as typeScale, iconSize, type Theme } from "@/theme";
import { SearchField } from "@/components/SearchField";
import { D3_JS } from "@/webview-assets/d3-assets";
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
}: {
  graph: KnowledgeGraph;
  onSelectNode?: (node: { id: string; type: string }) => void;
  /** Controlled layout mode. When provided the in-body Force/Radial segment is
   *  hidden and the parent (native toolbar) drives it. */
  mode?: GraphMode;
  onModeChange?: (mode: GraphMode) => void;
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
  const [labelMode, setLabelMode] = useState<LabelMode>("smart");
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
      links: filtered.edges.map((e) => {
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
  }, [filtered, t, isDark, showHulls, labelMode, mode]);

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

        {/* Label mode dropdown — force only (radial drills in, no label modes) */}
        {mode === "force" ? (
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

      {/* Label-mode dropdown menu (overlay) */}
      {labelOpen && mode === "force" ? (
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
        />

        {/* Legend overlay — bottom-left. Offset by the safe-area inset so it
            clears the home indicator / tab bar. Hidden in radial (it drills). */}
        {mode === "force" ? (
          <View style={[styles.legend, { bottom: 16 + insets.bottom }]}>
            {ALL_NODE_TYPES.filter((type) => activeTypes.has(type)).map((type) => (
              <View key={type} style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: nodeTypeColor(type, t) }]} />
                <Text style={styles.legendLabel} numberOfLines={1}>{type}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** Build the self-contained graph document: D3 lib + force sim + sunburst. */
function buildGraphHtml(payload: string): string {
  return `<!doctype html><html><head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <style>
      html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
      #g { width: 100vw; height: 100vh; display: block; -webkit-tap-highlight-color: transparent; }
      text { font-family: -apple-system, system-ui, sans-serif; -webkit-user-select: none; user-select: none; }
    </style>
  </head><body>
    <svg id="g"></svg>
    <script>${D3_JS}</script>
    <script>
      (function () {
        var DATA = ${payload};
        var W = window.innerWidth, H = window.innerHeight;
        var post = function (o) { window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(o)); };

        function withAlpha(c, a) {
          var h = String(c).replace('#', '');
          if (h.length === 3) h = h.split('').map(function (x) { return x + x; }).join('');
          var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
          if (isNaN(r) || isNaN(g) || isNaN(b)) return c;
          return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
        }

        var svg = d3.select('#g').attr('viewBox', [0, 0, W, H]);
        if (DATA.mode === 'radial') { renderRadial(); } else { renderForce(); }

        // ══ FORCE-DIRECTED ═══════════════════════════════════════════════════
        function renderForce() {
          var root = svg.append('g');

          // cluster hulls
          var hullLayer = root.append('g');
          var hullLine = d3.line().curve(d3.curveCatmullRomClosed.alpha(0.6));
          var projectsById = {};
          DATA.nodes.forEach(function (n) { if (n.isProject) projectsById[n.id] = n; });
          var membersByProject = {};
          DATA.nodes.forEach(function (n) {
            var pid = n.isProject ? n.id : n.projectId;
            if (!pid || !projectsById[pid]) return;
            (membersByProject[pid] = membersByProject[pid] || []).push(n);
          });
          function drawHulls() {
            if (!DATA.showHulls) { hullLayer.selectAll('path').remove(); return; }
            var polys = [];
            Object.keys(membersByProject).forEach(function (pid) {
              var pts = membersByProject[pid]
                .filter(function (n) { return n.x != null && n.y != null; })
                .map(function (n) { return [n.x, n.y]; });
              if (pts.length < 3) return;
              var hull = d3.polygonHull(pts);
              if (!hull) return;
              var cx = d3.mean(hull, function (d) { return d[0]; });
              var cy = d3.mean(hull, function (d) { return d[1]; });
              var pad = 22;
              var expanded = hull.map(function (p) {
                var dx = p[0] - cx, dy = p[1] - cy, m = Math.hypot(dx, dy) || 1;
                return [p[0] + (dx / m) * pad, p[1] + (dy / m) * pad];
              });
              polys.push(hullLine(expanded));
            });
            var paths = hullLayer.selectAll('path').data(polys);
            paths.exit().remove();
            paths.enter().append('path')
              .attr('fill', withAlpha(DATA.theme.accent, 0.05))
              .attr('stroke', withAlpha(DATA.theme.accent, 0.18))
              .attr('stroke-width', 1.2)
              .merge(paths)
              .attr('d', function (d) { return d; });
          }

          var link = root.append('g').selectAll('line').data(DATA.links).join('line')
            .attr('stroke', function (d) { return d.color; })
            .attr('stroke-opacity', function (d) { return d.opacity; })
            .attr('stroke-width', function (d) { return d.width || 1; })
            .attr('stroke-dasharray', function (d) { return d.dash ? '3,3' : null; });

          var selectedId = null, hoveredId = null;
          var node = root.append('g').selectAll('g').data(DATA.nodes).join('g').style('cursor', 'pointer');
          var circles = node.append('circle')
            .attr('r', function (d) { return d.r; })
            .attr('fill', function (d) { return withAlpha(d.color, 0.92); })
            .attr('stroke', function (d) { return d.color; })
            .attr('stroke-width', 0);

          var labels = node.append('text')
            .attr('text-anchor', 'middle')
            .attr('paint-order', 'stroke')
            .attr('stroke', DATA.theme.bg)
            .attr('stroke-linejoin', 'round')
            .attr('stroke-width', 3)
            .text(function (d) {
              return d.title.length > d.labelMax ? d.title.slice(0, d.labelMax - 1) + '…' : d.title;
            });

          function labelVisible(d, k) {
            if (d.isProject || d.id === selectedId || d.id === hoveredId) return true;
            if (DATA.labelMode === 'all') return k >= 0.7;
            if (DATA.labelMode === 'smart') return k >= 1.5;
            return false;
          }
          function updateLabels(k) {
            labels
              .attr('display', function (d) { return labelVisible(d, k) ? null : 'none'; })
              .attr('font-size', function (d) { return d.labelPx; })
              .attr('font-weight', function (d) { return d.isProject ? '600' : '400'; })
              .attr('y', function (d) { return d.r + 4 + d.labelPx; })
              .attr('fill', function (d) { return d.isProject ? DATA.theme.text : DATA.theme.textSecondary; });
          }
          updateLabels(1);

          node.on('click', function (e, d) { post({ type: 'select', id: d.id, nodeType: d.type }); });

          var sim = d3.forceSimulation(DATA.nodes)
            .force('link', d3.forceLink(DATA.links).id(function (d) { return d.id; })
              .distance(function (l) { return l.distance; }).strength(DATA.forces.linkStrength))
            .force('charge', d3.forceManyBody().strength(function (d) { return d.charge; }))
            .force('x', d3.forceX(function (d) { return W / 2 + d.anchorX; }).strength(function (d) { return d.anchorStrength; }))
            .force('y', d3.forceY(function (d) { return H / 2 + d.anchorY; }).strength(function (d) { return d.anchorStrength; }))
            .force('collide', d3.forceCollide().radius(function (d) { return d.collideR; }).iterations(DATA.forces.collideIterations))
            .alphaDecay(DATA.forces.alphaDecay)
            .velocityDecay(DATA.forces.velocityDecay)
            .on('tick', function () {
              drawHulls();
              link
                .attr('x1', function (d) { return d.source.x; })
                .attr('y1', function (d) { return d.source.y; })
                .attr('x2', function (d) { return d.target.x; })
                .attr('y2', function (d) { return d.target.y; });
              node.attr('transform', function (d) { return 'translate(' + d.x + ',' + d.y + ')'; });
            });

          var zoom = d3.zoom().scaleExtent([0.2, 6]).on('zoom', function (e) {
            root.attr('transform', e.transform);
            circles.attr('stroke-width', function (d) {
              return (d.id === selectedId || d.id === hoveredId) ? 1.6 / e.transform.k : 0;
            });
            updateLabels(e.transform.k);
          });
          svg.call(zoom);
          svg.call(zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(0.85).translate(-W / 2, -H / 2));

          node.call(d3.drag()
            .on('start', function (e, d) { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
            .on('drag', function (e, d) { d.fx = e.x; d.fy = e.y; })
            .on('end', function (e, d) { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));
        }

        // ══ RADIAL / SUNBURST ════════════════════════════════════════════════
        function renderRadial() {
          var INNER_R = 38, INNER_R_FOCUSED = 120;
          var cx = W / 2, cy = H / 2;
          var maxR = Math.min(W, H) / 2 - 20;

          var root = d3.hierarchy(DATA.hierarchy)
            .sum(function (d) { return (d.children && d.children.length) ? 0 : 1; })
            .sort(function (a, b) { return (b.value || 0) - (a.value || 0); });
          d3.partition().size([2 * Math.PI, root.height + 1])(root);

          var focus = root;
          var g = svg.append('g').attr('transform', 'translate(' + cx + ',' + cy + ')');

          function visibleLevels(f) { return Math.max(1, root.height - f.depth); }
          function innerRadiusFor(f) { return f === root ? INNER_R : Math.min(INNER_R_FOCUSED, maxR * 0.45); }
          function ringR(y, innerR, levels) {
            var band = (maxR - innerR) / levels;
            return innerR + Math.min(y, levels) * band;
          }
          function targetArc(d) {
            var span = (focus.x1 - focus.x0) || 1;
            var x0 = Math.max(0, Math.min(1, (d.x0 - focus.x0) / span)) * 2 * Math.PI;
            var x1 = Math.max(0, Math.min(1, (d.x1 - focus.x0) / span)) * 2 * Math.PI;
            var y0 = Math.max(0, d.y0 - focus.depth - 1);
            var y1 = Math.max(0, d.y1 - focus.depth - 1);
            return { x0: x0, x1: x1, y0: y0, y1: y1 };
          }

          var arcGen = d3.arc()
            .startAngle(function (a) { return a.x0; })
            .endAngle(function (a) { return a.x1; })
            .innerRadius(function (a) { return a._r0; })
            .outerRadius(function (a) { return a._r1; })
            .padAngle(0.004)
            .padRadius(maxR);

          var wedges = g.append('g');
          var hub = g.append('g');

          // Persisted per-node arc state so drill-in / back can be tweened
          // (mirrors desktop zoomTo): current = where each wedge is drawn now.
          var current = new Map();
          var animGeom = { innerR: innerRadiusFor(root), levels: visibleLevels(root) };
          var animId = 0;

          function drawFrame() {
            var innerR = animGeom.innerR;
            var levels = animGeom.levels;
            var arcs = [];
            root.each(function (d) {
              if (d === root) return;
              var a = current.get(d) || targetArc(d);
              if (a.x1 - a.x0 < 0.002 || a.y1 <= 0) return;
              a._r0 = ringR(a.y0, innerR, levels);
              a._r1 = ringR(a.y1, innerR, levels) - 1.5;
              if (a._r1 <= a._r0) return;
              a._d = d;
              arcs.push(a);
            });
            render(arcs, innerR);
          }

          // Animate the focus change: interpolate every node's arc + the ring
          // geometry from their current values to the new focus targets.
          function zoomTo(node) {
            var fromInnerR = animGeom.innerR;
            var fromLevels = animGeom.levels;
            focus = node;
            var toInnerR = innerRadiusFor(node);
            var toLevels = visibleLevels(node);
            var from = new Map();
            var to = new Map();
            root.each(function (d) {
              from.set(d, current.get(d) || targetArc(d));
              to.set(d, targetArc(d));
            });
            var start = null;
            var dur = 520;
            cancelAnimationFrame(animId);
            function tick(now) {
              if (start === null) start = now;
              var t = Math.min(1, (now - start) / dur);
              var e = d3.easeCubicInOut(t);
              animGeom = {
                innerR: fromInnerR + (toInnerR - fromInnerR) * e,
                levels: fromLevels + (toLevels - fromLevels) * e,
              };
              root.each(function (d) {
                var a = from.get(d), b = to.get(d);
                current.set(d, {
                  x0: a.x0 + (b.x0 - a.x0) * e,
                  x1: a.x1 + (b.x1 - a.x1) * e,
                  y0: a.y0 + (b.y0 - a.y0) * e,
                  y1: a.y1 + (b.y1 - a.y1) * e,
                });
              });
              drawFrame();
              if (t < 1) animId = requestAnimationFrame(tick);
            }
            animId = requestAnimationFrame(tick);
          }

          function render(arcs, innerR) {
            var sel = wedges.selectAll('path').data(arcs, function (a) { return a._d.data.id; });
            sel.exit().remove();
            sel.enter().append('path')
              .style('cursor', 'pointer')
              .on('click', function (e, a) {
                var d = a._d;
                if (d.data.type !== 'workspace' && d.data.type !== 'branch') {
                  post({ type: 'select', id: d.data.id, nodeType: d.data.type });
                }
                if (d.children && d.children.length) { zoomTo(d); }
              })
              .merge(sel)
              .attr('d', function (a) { return arcGen(a); })
              .attr('fill', function (a) {
                var isBranch = a._d.depth === focus.depth + 1 && a._d.children && a._d.children.length;
                return withAlpha(a._d.data.color, isBranch ? 1 : 0.62);
              })
              .attr('stroke', DATA.theme.bg)
              .attr('stroke-width', 1);

            // labels — branches (wide inner ring) get centred labels; leaves radial.
            var labelSel = wedges.selectAll('text').data(arcs.filter(function (a) {
              var isBranch = a._d.depth === focus.depth + 1 && a._d.children && a._d.children.length;
              var arcLenInner = (a.x1 - a.x0) * a._r0;
              return isBranch || (arcLenInner >= 9 && (a.x1 - a.x0) > 0.012 && (a._r1 - a._r0) > 12);
            }), function (a) { return 'L' + a._d.data.id; });
            labelSel.exit().remove();
            labelSel.enter().append('text').merge(labelSel)
              .each(function (a) {
                var d = a._d;
                var ang = (a.x0 + a.x1) / 2;
                var isBranch = d.depth === focus.depth + 1 && d.children && d.children.length;
                var flip = ang >= Math.PI;
                var fontPx = isBranch ? 12 : 11;
                var ringDepth = a._r1 - a._r0;
                var maxChars = Math.max(2, Math.floor((ringDepth - 8) / (fontPx * 0.58)));
                var label = d.data.title;
                if (label.length > maxChars) label = label.slice(0, maxChars - 1) + '…';
                var el = d3.select(this)
                  .text(label)
                  .attr('font-size', fontPx)
                  .attr('font-weight', isBranch ? '600' : '400')
                  .attr('fill', isBranch ? DATA.theme.accentFg : DATA.theme.text)
                  .attr('dominant-baseline', 'middle');
                var rot = (ang - Math.PI / 2) * 180 / Math.PI;
                if (isBranch) {
                  var rr = (a._r0 + a._r1) / 2;
                  el.attr('text-anchor', 'middle')
                    .attr('transform', 'rotate(' + rot + ') translate(' + rr + ',0)' + (flip ? ' rotate(180)' : ''));
                } else if (flip) {
                  el.attr('text-anchor', 'start')
                    .attr('transform', 'rotate(' + rot + ') translate(' + (a._r1 - 4) + ',0) rotate(180)');
                } else {
                  el.attr('text-anchor', 'start')
                    .attr('transform', 'rotate(' + rot + ') translate(' + (a._r0 + 4) + ',0)');
                }
              });

            // hub — focus label + back affordance
            hub.selectAll('*').remove();
            hub.append('circle')
              .attr('r', innerR - 3)
              .attr('fill', withAlpha(DATA.theme.surface, 0.95))
              .attr('stroke', focus === root ? DATA.theme.border : withAlpha(DATA.theme.accent, 0.5))
              .attr('stroke-width', focus === root ? 1 : 1.5)
              .style('cursor', focus === root ? 'default' : 'pointer')
              .on('click', function () { if (focus !== root) { zoomTo(focus.parent || root); } });
            if (focus === root) {
              hub.append('text').text('Workspace')
                .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
                .attr('font-size', 11).attr('font-weight', '600').attr('fill', DATA.theme.textSecondary);
            } else {
              var title = focus.data.title.length > 18 ? focus.data.title.slice(0, 17) + '…' : focus.data.title;
              hub.append('text').text(title)
                .attr('text-anchor', 'middle').attr('y', -8)
                .attr('font-size', 14).attr('font-weight', '600').attr('fill', DATA.theme.text);
              hub.append('text').text('← back')
                .attr('text-anchor', 'middle').attr('y', 14)
                .attr('font-size', 11).attr('fill', withAlpha(DATA.theme.accent, 0.9))
                .style('cursor', 'pointer')
                .on('click', function () { zoomTo(focus.parent || root); });
            }
          }

          // Seed resting positions, then paint the first frame.
          root.each(function (d) { if (!current.has(d)) current.set(d, targetArc(d)); });
          drawFrame();
        }
      })();
    </script>
  </body></html>`;
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
    legend: {
      position: "absolute",
      left: 16,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: withAlpha(t.surface, 0.9),
    },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 },
    legendDot: { width: 10, height: 10, borderRadius: 5 },
    legendLabel: { fontSize: 11, color: t.textTertiary, textTransform: "capitalize" },
  });
}
