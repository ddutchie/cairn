"use client";

import React, { useRef, useEffect, useMemo } from "react";
import type { Scene, Points, Camera } from "three";
import type { GraphNode, KnowledgeGraph } from "@/types";
import { createCssVarReader, withAlpha, tokenToCssVar } from "@/lib/viz/color";
import { useContainerDims } from "@/lib/viz/hooks";
import {
  nodeTypeToken,
  nodeRadius,
  edgeStyle,
  chargeStrength,
  linkDistance,
  type GraphNodeType,
} from "../../../shared/ui/graph";

interface Props {
  graph: KnowledgeGraph;
  selectedNodeId: string | null;
  onNodeClick: (node: GraphNode) => void;
  onBackgroundClick: () => void;
  spacing: number;
  semanticThreshold?: number;
}

type Node3D = {
  id: string;
  title: string;
  nodeType: GraphNodeType;
  x?: number;
  y?: number;
  z?: number;
};
type Link3D = { source: string | Node3D; target: string | Node3D; edgeType: string; weight: number };

// Minimal surface of the 3d-force-graph instance this component uses (the
// package's own typings are generic over node/link shapes and awkward to chain).
interface Instance {
  graphData(d: { nodes: Node3D[]; links: Link3D[] }): Instance;
  width(w: number): Instance;
  height(h: number): Instance;
  backgroundColor(c: string): Instance;
  showNavInfo(v: boolean): Instance;
  nodeColor(fn: (n: Node3D) => string): Instance;
  nodeVal(fn: (n: Node3D) => number): Instance;
  nodeLabel(fn: (n: Node3D) => string): Instance;
  nodeOpacity(o: number): Instance;
  nodeResolution(r: number): Instance;
  linkColor(fn: (l: Link3D) => string): Instance;
  linkWidth(fn: (l: Link3D) => number): Instance;
  linkOpacity(o: number): Instance;
  onNodeClick(fn: (n: Node3D) => void): Instance;
  onBackgroundClick(fn: () => void): Instance;
  onNodeHover(fn: (n: Node3D | null) => void): Instance;
  d3Force(name: string): { strength?: (f: (n: Node3D) => number) => unknown; distance?: (f: (l: Link3D) => number) => unknown } | undefined;
  d3ReheatSimulation(): Instance;
  cameraPosition(pos: { x?: number; y?: number; z?: number }, lookAt?: { x: number; y: number; z: number }, ms?: number): Instance;
  zoomToFit(ms?: number, padding?: number): Instance;
  controls(): { autoRotate: boolean; autoRotateSpeed: number };
  pauseAnimation(): Instance;
  resumeAnimation(): Instance;
  scene(): Scene;
  camera(): Camera;
  _destructor(): void;
}

/** Star field used as a skybox: it follows the camera position (so zooming out can't
 *  pass through it) but not its rotation, so orbiting visibly sweeps the stars. */
interface Backdrop {
  stars: Points;
  dispose(): void;
}

function createBackdrop(THREE: typeof import("three"), scene: Scene): Backdrop {
  const count = 700;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Uniform on a sphere shell, far outside the graph.
    const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = 800 + Math.random() * 100;
    const k = Math.sqrt(1 - u * u);
    pos[i * 3] = r * k * Math.cos(a);
    pos[i * 3 + 1] = r * u;
    pos[i * 3 + 2] = r * k * Math.sin(a);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  // Soft round sprite — default points render as hard squares.
  const cv = document.createElement("canvas");
  cv.width = cv.height = 32;
  const ctx = cv.getContext("2d")!;
  const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.4, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 32, 32);
  const map = new THREE.CanvasTexture(cv);
  const mat = new THREE.PointsMaterial({ size: 4, sizeAttenuation: false, map, transparent: true, opacity: 0.6, depthWrite: false });
  const stars = new THREE.Points(geo, mat);
  scene.add(stars);
  return {
    stars,
    dispose() {
      scene.remove(stars);
      geo.dispose(); mat.dispose(); map.dispose();
    },
  };
}

/** Corner axis gizmo: a tiny second scene whose camera mirrors the main camera's
 *  orientation, so the labelled axes always show which way the graph is turned. */
interface Gizmo {
  /** Re-sync with the main camera and draw one frame. */
  render(mainCamera: Camera): void;
  setColors(x: string, y: string, z: string, label: string): void;
  dispose(): void;
}

const GIZMO_AXES = [
  { label: "X", dir: [1, 0, 0] },
  { label: "Y", dir: [0, 1, 0] },
  { label: "Z", dir: [0, 0, 1] },
] as const;

function createGizmo(THREE: typeof import("three"), canvas: HTMLCanvasElement, size: number): Gizmo {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(size, size, false);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20);
  const disposables: Array<{ dispose(): void }> = [];

  const lines: import("three").LineBasicMaterial[] = [];
  const sprites: import("three").SpriteMaterial[] = [];
  const labelTex: import("three").CanvasTexture[] = [];
  for (const { dir } of GIZMO_AXES) {
    const v = new THREE.Vector3(...dir);
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), v]);
    const mat = new THREE.LineBasicMaterial({ linewidth: 2 });
    scene.add(new THREE.Line(geo, mat));
    lines.push(mat);
    disposables.push(geo, mat);

    const cv = document.createElement("canvas");
    cv.width = cv.height = 64;
    const tex = new THREE.CanvasTexture(cv);
    const sm = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const sp = new THREE.Sprite(sm);
    sp.position.copy(v.clone().multiplyScalar(1.3));
    sp.scale.setScalar(0.55);
    scene.add(sp);
    sprites.push(sm);
    labelTex.push(tex);
    disposables.push(sm, tex);
  }
  const letters = GIZMO_AXES.map((a) => a.label);
  const drawLabels = (colors: string[]) => {
    labelTex.forEach((tex, i) => {
      const cv = tex.image as HTMLCanvasElement;
      const ctx = cv.getContext("2d")!;
      ctx.clearRect(0, 0, 64, 64);
      ctx.fillStyle = colors[i];
      ctx.font = "600 40px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(letters[i], 32, 34);
      tex.needsUpdate = true;
    });
  };

  return {
    render(mainCamera) {
      camera.position.set(0, 0, 4.2).applyQuaternion(mainCamera.quaternion);
      camera.quaternion.copy(mainCamera.quaternion);
      renderer.render(scene, camera);
    },
    setColors(x, y, z) {
      const cols = [x, y, z];
      lines.forEach((m, i) => m.color.set(cols[i]));
      drawLabels(cols);
    },
    dispose() {
      for (const d of disposables) d.dispose();
      renderer.dispose();
    },
  };
}

const GIZMO_PX = 88;

export function Graph3DCanvas({ graph, selectedNodeId, onNodeClick, onBackgroundClick, spacing, semanticThreshold = 1 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<Instance | null>(null);
  const backdropRef = useRef<Backdrop | null>(null);
  const gizmoRef = useRef<Gizmo | null>(null);
  const gizmoCanvasRef = useRef<HTMLCanvasElement>(null);
  const dims = useContainerDims(containerRef);
  const [ready, setReady] = React.useState(false);

  // Latest props for the long-lived instance callbacks.
  const propsRef = useRef({ selectedNodeId, onNodeClick, onBackgroundClick, spacing, graph });
  // eslint-disable-next-line react-hooks/refs -- keep latest value for callbacks owned by the WebGL instance
  propsRef.current = { selectedNodeId, onNodeClick, onBackgroundClick, spacing, graph };
  const hoveredRef = useRef<string | null>(null);

  const edges = useMemo(
    () => graph.edges.filter((e) => e.type !== "semantic" || (e.weight ?? 1) >= semanticThreshold),
    [graph.edges, semanticThreshold],
  );

  // Selected node + direct neighbours stay lit; everything else dims.
  const related = useMemo(() => {
    if (!selectedNodeId) return null;
    const s = new Set<string>([selectedNodeId]);
    for (const e of edges) {
      if (e.source === selectedNodeId) s.add(e.target);
      else if (e.target === selectedNodeId) s.add(e.source);
    }
    return s;
  }, [selectedNodeId, edges]);
  const relatedRef = useRef(related);
  // eslint-disable-next-line react-hooks/refs -- read by instance accessors
  relatedRef.current = related;

  const applyStyle = React.useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const read = createCssVarReader();
    const color = (token: Parameters<typeof tokenToCssVar>[0]) => read(tokenToCssVar(token));
    const rel = relatedRef.current;
    const bd = backdropRef.current;
    if (bd) {
      (bd.stars.material as import("three").PointsMaterial).color.set(color("textTertiary"));
    }
    gizmoRef.current?.setColors(color("nodeProject"), color("success"), color("info"), color("textPrimary"));
    fg.backgroundColor(color("background"))
      .nodeColor((n) => {
        const c = color(nodeTypeToken(n.nodeType));
        return rel && !rel.has(n.id) ? withAlpha(c, 0.25) : c;
      })
      .linkColor((l) => {
        const st = edgeStyle(l.edgeType);
        const s = typeof l.source === "object" ? l.source.id : l.source;
        const t = typeof l.target === "object" ? l.target.id : l.target;
        const dim = rel && !(rel.has(s) && rel.has(t));
        return withAlpha(color(st.token), dim ? 0.08 : Math.min(1, st.opacity + 0.2));
      });
  }, []);

  // Create the instance once; the three.js chunk loads lazily on first use.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    let gizmoRaf = 0;
    void Promise.all([import("3d-force-graph"), import("three")]).then(([{ default: ForceGraph3D }, THREE]) => {
      if (cancelled || !containerRef.current) return;
      // Orbit controls (not the default trackball) — only they support autoRotate.
      const fg = (ForceGraph3D as unknown as (o: { controlType: "orbit" }) => (el: HTMLElement) => Instance)({ controlType: "orbit" })(containerRef.current);
      fg.showNavInfo(false)
        .nodeOpacity(0.95)
        .nodeResolution(12)
        .nodeVal((n) => Math.pow(nodeRadius(n.nodeType) / 6, 2))
        .nodeLabel((n) => n.title.replace(/</g, "&lt;"))
        .linkOpacity(1)
        .linkWidth((l) => (l.edgeType === "semantic" && l.weight < 1 ? 0.3 + l.weight * 0.4 : 0.5))
        .onNodeClick((n) => {
          const found = propsRef.current.graph.nodes.find((g) => g.id === n.id);
          if (found) propsRef.current.onNodeClick(found);
        })
        .onBackgroundClick(() => propsRef.current.onBackgroundClick())
        .onNodeHover((n) => {
          hoveredRef.current = n ? n.id : null;
          if (containerRef.current) containerRef.current.style.cursor = n ? "pointer" : "grab";
        });
      fgRef.current = fg;
      const backdrop = createBackdrop(THREE, fg.scene());
      backdropRef.current = backdrop;
      if (gizmoCanvasRef.current) gizmoRef.current = createGizmo(THREE, gizmoCanvasRef.current, GIZMO_PX);
      const tick = () => {
        const cam = fg.camera();
        backdrop.stars.position.copy(cam.position);
        gizmoRef.current?.render(cam);
        gizmoRaf = requestAnimationFrame(tick);
      };
      tick();
      applyStyle();
      // Re-run the data/spacing/size effects, which ran before the chunk loaded.
      setReady(true);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(gizmoRaf);
      gizmoRef.current?.dispose();
      gizmoRef.current = null;
      backdropRef.current?.dispose();
      backdropRef.current = null;
      fgRef.current?._destructor();
      fgRef.current = null;
      setReady(false);
      el.replaceChildren();
    };
  }, [applyStyle]);

  // Data: reuse node objects by id so existing positions survive a refresh.
  const nodeCache = useRef(new Map<string, Node3D>());
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const cache = nodeCache.current;
    const nodes: Node3D[] = graph.nodes.map((g) => {
      const prev = cache.get(g.id);
      if (prev) { prev.title = g.title; prev.nodeType = g.type; return prev; }
      const n: Node3D = { id: g.id, title: g.title, nodeType: g.type };
      cache.set(g.id, n);
      return n;
    });
    const ids = new Set(nodes.map((n) => n.id));
    for (const k of cache.keys()) if (!ids.has(k)) cache.delete(k);
    const links: Link3D[] = edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, edgeType: e.type, weight: e.weight ?? 1 }));
    fg.graphData({ nodes, links });
    fg.nodeLabel((n) => n.title.replace(/</g, "&lt;"));
    applyStyle();
  }, [graph.nodes, edges, ready, applyStyle]);

  // Spacing reuses the 2D charge/link rules from shared/ui/graph.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    fg.d3Force("charge")?.strength?.((n) => chargeStrength(n.nodeType, degree.get(n.id) ?? 0, spacing));
    fg.d3Force("link")?.distance?.((l) => linkDistance(l.edgeType, spacing));
    fg.d3ReheatSimulation();
  }, [spacing, edges, ready]);

  useEffect(() => { fgRef.current?.width(dims.width).height(dims.height); }, [dims.width, dims.height, ready]);
  useEffect(() => { applyStyle(); }, [related, ready, applyStyle]);

  // Re-resolve colours when the theme attribute flips.
  useEffect(() => {
    const obs = new MutationObserver((m) => {
      if (m.some((x) => x.attributeName === "data-theme")) requestAnimationFrame(() => applyStyle());
    });
    obs.observe(document.documentElement, { attributes: true });
    return () => obs.disconnect();
  }, [applyStyle]);

  const [autoRotate, setAutoRotate] = React.useState(false);
  useEffect(() => {
    const c = fgRef.current?.controls();
    if (c) { c.autoRotate = autoRotate; c.autoRotateSpeed = 1.2; }
  }, [autoRotate, ready]);

  // Frame the whole graph once it first settles.
  const fitted = useRef(false);
  useEffect(() => {
    if (!ready || fitted.current) return;
    const t = setTimeout(() => { fgRef.current?.zoomToFit(600, 60); fitted.current = true; }, 1500);
    return () => clearTimeout(t);
  }, [ready]);

  const btn =
    "px-2 h-7 flex items-center justify-center rounded-md bg-[var(--surface)] border border-[var(--border)] text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors shadow-sm";

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="absolute inset-0 overflow-hidden" style={{ cursor: "grab" }} />
      <canvas
        ref={gizmoCanvasRef}
        aria-hidden
        className="absolute bottom-4 right-4 pointer-events-none rounded-full border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_70%,transparent)]"
        style={{ width: GIZMO_PX, height: GIZMO_PX }}
      />
      <div className="absolute top-3 right-3 flex flex-col gap-1.5">
        <button className={btn} onClick={() => fgRef.current?.zoomToFit(400, 60)}>Fit</button>
        <button
          className={btn}
          aria-pressed={autoRotate}
          style={autoRotate ? { color: "var(--accent)", background: "var(--accent-dim)" } : undefined}
          onClick={() => setAutoRotate((v) => !v)}
        >
          Rotate
        </button>
      </div>
    </div>
  );
}
