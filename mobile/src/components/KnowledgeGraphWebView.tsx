import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useTheme, useIsDark } from "@/theme";
import { haptics } from "@/haptics";
import { buildGraphHtml } from "@/components/graph/graph-webview-html";
import { GraphChrome } from "@/components/graph/GraphChrome";
import { useGraphControls, type GraphMode } from "@/graph/useGraphControls";
import { tokenColor, nodeTypeColor } from "@/graph/colors";
import type { KnowledgeGraph } from "@/db/queries";
import {
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
  type LabelMode,
  type HierarchyNode,
} from "@cairn/shared/ui/graph";

export type { GraphMode };

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
  const ref = useRef<WebView>(null);

  // iOS reclaims a backgrounded WKWebView's content process under memory
  // pressure, leaving the graph blank. reload() on a dead process is unreliable
  // (it frequently no-ops or restores a blank document — that's why swapping the
  // layout type "fixes" it: the type change regenerates `html` and remounts).
  // So instead of reload(), we REMOUNT the WebView by bumping a key, which tears
  // down the dead native view and builds a fresh one from the in-memory `html`.
  //   • webKey        — bumping it forces the remount.
  //   • terminatedRef — set when a process death is observed while backgrounded,
  //                     so we can rebuild on the NEXT foreground (the terminate
  //                     callback itself may arrive while JS is suspended, or the
  //                     remount won't stick until the view is visible again).
  const [webKey, setWebKey] = useState(0);
  const terminatedRef = useRef(false);
  const remount = useCallback(() => setWebKey((k) => k + 1), []);
  const handleTerminate = useCallback(() => {
    if (AppState.currentState === "active") remount();
    else terminatedRef.current = true; // rebuild when we return to the foreground
  }, [remount]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && terminatedRef.current) {
        terminatedRef.current = false;
        remount();
      }
    });
    return () => sub.remove();
  }, [remount]);

  const {
    mode, setMode, labelMode, setLabelMode, activeTypes, toggleType,
    showHulls, toggleHulls, search, setSearch, filtered, showModeToggle, showLabelPill,
  } = useGraphControls(graph, {
    mode: modeProp, onModeChange, labelMode: labelModeProp, onLabelModeChange,
  });

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

  return (
    <GraphChrome
      mode={mode}
      onModeChange={setMode}
      showModeToggle={showModeToggle}
      labelMode={labelMode}
      onLabelModeChange={setLabelMode}
      showLabelPill={showLabelPill}
      showHulls={showHulls}
      onToggleHulls={toggleHulls}
      showSemantic={showSemantic}
      onToggleSemantic={onToggleSemantic}
      semanticAvailable={semanticAvailable}
      semanticLoading={semanticLoading}
      search={search}
      onSearchChange={setSearch}
      activeTypes={activeTypes}
      onToggleType={toggleType}
      nodeCount={filtered.nodes.length}
      edgeCount={filtered.edges.length}
      onFit={fitToView}
    >
        <WebView
          ref={ref}
          key={webKey}
          originWhitelist={["*"]}
          source={{ html }}
          style={{ flex: 1, backgroundColor: "transparent" }}
          onMessage={onMessage}
          onLoadEnd={() => {
            // After any (re)load — including a post-termination remount — the
            // fresh document reflects whatever html was last generated at a
            // structural change. Re-push the live force-mode toggles so a
            // rebuild can't revert hulls/labels/links the user changed since.
            if (mode === "force") pushUpdate({ showHulls, labelMode, links: linksPayload });
          }}
          onShouldStartLoadWithRequest={(req) =>
            req.url === "about:blank" || req.url.startsWith("data:") || req.navigationType === "other"
          }
          javaScriptEnabled
          setSupportMultipleWindows={false}
          scrollEnabled={false}
          // iOS kills the WKWebView content process when the app is backgrounded
          // under memory pressure, leaving the graph blank (and injectJavaScript
          // updates silently no-op on a dead process). reload() is unreliable
          // here, so handleTerminate REMOUNTS the WebView (fresh native view from
          // the in-memory html) — immediately if foregrounded, else on the next
          // foreground. Android equivalent is onRenderProcessGone.
          onContentProcessDidTerminate={handleTerminate}
          onRenderProcessGone={handleTerminate}
        />
    </GraphChrome>
  );
}
