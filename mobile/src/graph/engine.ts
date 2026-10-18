import type { SkPicture } from "@shopify/react-native-skia";
import type { Theme } from "@/theme";
import { haptics } from "@/haptics";
import { buildHierarchy, type LabelMode } from "@cairn/shared/ui/graph";
import type { GraphData } from "./filter";
import type { GraphEdge } from "@/db/types";
import {
  createForceLayout,
  snapshotPositions,
  VISUALLY_SETTLED_ALPHA,
  type ForceLayout,
} from "./layout";
import {
  boundsOf,
  centeredCamera,
  easeCubicInOut,
  fitCamera,
  hitNode,
  lerpCamera,
  screenToWorld,
  zoomAt,
  type Camera,
} from "./camera";
import {
  buildRadialTree,
  computeArcs,
  hasChildren,
  hitRadial,
  interpolateArcs,
  restingGeom,
  targetArcs,
  type ArcState,
  type RingGeom,
  type RNode,
} from "./radial";
import { recordForceScene, recordRadialScene } from "./scene";
import type { GraphMode } from "./useGraphControls";

const FIT_MS = 450;
const RADIAL_MS = 520;
/** Simulation ticks per frame while the layout is still moving. */
const TICKS_PER_FRAME = 2;
/** Ticks run before the first frame so the graph doesn't open as a blob. */
const WARMUP_TICKS = 24;
const IDENTITY: Camera = { k: 1, tx: 0, ty: 0 };

export interface EngineCallbacks {
  onPicture(p: SkPicture): void;
  onCamera(c: Camera): void;
}

export interface EngineOptions {
  mode: GraphMode;
  labelMode: LabelMode;
  showHulls: boolean;
  reducedMotion: boolean;
}

/** zoom → label level-of-detail bucket (thresholds from shouldShowLabel). */
const lodBucket = (k: number) => (k >= 1.5 ? 2 : k >= 0.7 ? 1 : 0);

/**
 * Imperative core of the Skia graph: owns the layout, the camera, the radial
 * drill-in state and a single requestAnimationFrame loop that records one
 * SkPicture per frame. React only mounts the canvas, forwards gestures and
 * receives pictures/cameras, so ticking never goes through reconciliation.
 * The loop sleeps whenever nothing moves.
 */
export class GraphEngine {
  private layout: ForceLayout | null = null;
  private graph: GraphData = { nodes: [], edges: [] };
  private theme: Theme;
  private opts: EngineOptions;
  private w = 0;
  private h = 0;
  /** Height of controls floating over the top of the canvas; content is framed below it. */
  private top = 0;
  private cam: Camera = IDENTITY;
  private raf = 0;
  private dirty = true;
  private active = true;
  private disposed = false;
  private selectedId: string | null = null;
  private lod = 1;

  // force interaction
  private userInteracted = false;
  private didAutoFit = false;
  private grabbed: string | null = null;
  private gestureStart: Camera = IDENTITY;
  private pinchFocal = { x: 0, y: 0 };
  private camAnim: { from: Camera; to: Camera; start: number } | null = null;

  // radial state
  private root: RNode | null = null;
  private focus: RNode | null = null;
  private current = new Map<RNode, ArcState>();
  private geom: RingGeom = { innerR: 0, levels: 1 };
  private radialAnim: { from: Map<RNode, ArcState>; to: Map<RNode, ArcState>; fromGeom: RingGeom; toGeom: RingGeom; start: number } | null = null;

  /** Host navigation for a tapped node; swapped in by the component as props change. */
  onSelectNode: ((node: { id: string; type: string }) => void) | undefined;

  constructor(private cb: EngineCallbacks, theme: Theme, opts: EngineOptions) {
    this.theme = theme;
    this.opts = opts;
  }

  // ── configuration ──────────────────────────────────────────────────────────

  setSize(w: number, h: number) {
    if (w === this.w && h === this.h) return;
    const first = this.w === 0;
    const dw = w - this.w;
    const dh = h - this.h;
    this.w = w;
    this.h = h;
    if (this.opts.mode === "force") {
      this.setCamera(first ? centeredCamera(w, h, undefined, this.top) : { ...this.cam, tx: this.cam.tx + dw / 2, ty: this.cam.ty + dh / 2 });
    }
    if (this.root && this.focus) this.resetRadialGeometry();
    if (first) this.rebuild();
    this.invalidate();
  }

  /** Controls float over the canvas: frame and centre content in the area below them. */
  setTopInset(top: number) {
    if (Math.abs(top - this.top) < 0.5) return;
    this.top = top;
    if (this.w === 0) return;
    if (this.opts.mode === "force") {
      if (!this.userInteracted && this.layout) {
        if (this.didAutoFit) this.fit(true);
        else this.setCamera(centeredCamera(this.w, this.h, undefined, top));
      }
    } else if (this.root && this.focus) {
      this.resetRadialGeometry();
    }
    this.invalidate();
  }

  setTheme(t: Theme) {
    this.theme = t;
    this.invalidate();
  }

  setOptions(o: EngineOptions) {
    const modeChanged = o.mode !== this.opts.mode;
    this.opts = o;
    if (modeChanged) this.rebuild();
    this.invalidate();
  }

  /** New data. Keeps positions of surviving nodes so the graph doesn't re-scatter. */
  setGraph(g: GraphData) {
    const prev = this.graph;
    this.graph = g;
    if (this.w === 0) return; // built on first size
    const sameNodes =
      prev.nodes.length === g.nodes.length && prev.nodes.every((n, i) => n.id === g.nodes[i].id);
    if (this.opts.mode === "force" && this.layout && sameNodes) {
      // The screen hands over fresh objects on every focus: take their data (titles, projects).
      this.layout.setNodeData(g.nodes);
      this.layout.setEdges(g.edges as GraphEdge[]);
      this.invalidate();
    } else if (this.opts.mode === "radial" && this.root && sameNodes) {
      // Keep the drill-in a refresh would otherwise reset to the workspace.
      const focusId = this.focus?.data.id;
      this.root = buildRadialTree(buildHierarchy({ nodes: g.nodes }));
      this.focus = (focusId ? this.root.descendants().find((d) => d.data.id === focusId) : undefined) ?? this.root;
      this.radialAnim = null;
      this.resetRadialGeometry();
      this.invalidate();
    } else {
      this.rebuild();
    }
  }

  setSelected(id: string | null) {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.invalidate();
  }

  /** Pause when the screen is hidden or the app is backgrounded. */
  setActive(active: boolean) {
    this.active = active;
    if (active) this.invalidate();
    else this.stopLoop();
  }

  /** Undo dispose(): React re-runs effects (Fast Refresh, StrictMode) against the same engine. */
  revive() {
    this.disposed = false;
    this.invalidate();
  }

  dispose() {
    this.disposed = true;
    this.stopLoop();
    this.layout?.stop();
  }

  // ── build ──────────────────────────────────────────────────────────────────

  private rebuild() {
    if (this.w === 0) return;
    this.camAnim = null;
    this.radialAnim = null;
    if (this.opts.mode === "force") {
      const fresh = !this.layout; // first build, or coming back from radial
      const prev = this.layout ? snapshotPositions(this.layout.nodes) : undefined;
      this.layout?.stop();
      this.layout = createForceLayout(this.graph, prev);
      // A new node set refits once it looks settled (as the WebView did).
      this.didAutoFit = false;
      this.userInteracted = false;
      if (fresh) this.setCamera(centeredCamera(this.w, this.h, undefined, this.top));
      if (this.opts.reducedMotion) {
        this.layout.tick(300);
        this.didAutoFit = true;
        this.fit(false);
      } else {
        this.layout.tick(WARMUP_TICKS);
      }
    } else {
      this.layout?.stop();
      this.layout = null;
      this.setCamera(IDENTITY);
      this.root = buildRadialTree(buildHierarchy({ nodes: this.graph.nodes }));
      this.focus = this.root;
      this.resetRadialGeometry();
    }
    this.invalidate();
  }

  private resetRadialGeometry() {
    if (!this.root || !this.focus) return;
    this.geom = restingGeom(this.root, this.focus, this.maxR());
    this.current = targetArcs(this.root, this.focus);
  }

  private maxR() {
    return Math.min(this.w, this.h - this.top) / 2 - 20;
  }

  private centerY() {
    return this.top + (this.h - this.top) / 2;
  }

  // ── camera ─────────────────────────────────────────────────────────────────

  private setCamera(c: Camera) {
    this.cam = c;
    this.cb.onCamera(c);
    const b = lodBucket(c.k);
    if (b !== this.lod) {
      this.lod = b;
      this.invalidate();
    }
  }

  /** Frame every node; animated unless reduced motion is on. */
  fit(animated = true) {
    if (!this.layout || this.w === 0) return;
    const b = boundsOf(this.layout.nodes);
    if (!b) return;
    const to = fitCamera(b, this.w, this.h, undefined, this.top);
    if (animated && !this.opts.reducedMotion) {
      this.camAnim = { from: this.cam, to, start: performance.now() };
      this.schedule();
    } else {
      this.camAnim = null;
      this.setCamera(to);
      this.invalidate();
    }
  }

  fitFromUser() {
    this.userInteracted = true;
    haptics.selection();
    this.fit(true);
  }

  // ── gestures (screen coords relative to the canvas) ────────────────────────

  panBegin(x: number, y: number) {
    this.gestureStart = this.cam;
    this.grabbed = null;
    if (this.opts.mode !== "force" || !this.layout) return;
    const w = screenToWorld(this.cam, x, y);
    const hit = hitNode(this.layout.nodes, w.x, w.y, this.cam.k);
    if (hit) this.grabbed = hit.id;
  }

  panStart() {
    this.userInteracted = true;
    this.camAnim = null;
    if (this.grabbed) haptics.impact();
  }

  panMove(x: number, y: number, dx: number, dy: number) {
    if (this.opts.mode !== "force") return;
    if (this.grabbed && this.layout) {
      const w = screenToWorld(this.cam, x, y);
      this.layout.pin(this.grabbed, w.x, w.y);
      this.invalidate();
    } else {
      this.setCamera({ ...this.gestureStart, tx: this.gestureStart.tx + dx, ty: this.gestureStart.ty + dy });
    }
  }

  panEnd() {
    if (this.grabbed && this.layout) this.layout.release(this.grabbed);
    this.grabbed = null;
    if (this.selectedId) this.invalidate(); // selection ring width tracks zoom
    this.schedule();
  }

  pinchStart(fx: number, fy: number) {
    this.userInteracted = true;
    this.camAnim = null;
    this.gestureStart = this.cam;
    this.pinchFocal = { x: fx, y: fy };
  }

  pinchMove(scale: number, fx: number, fy: number) {
    if (this.opts.mode !== "force") return;
    const { x, y } = this.pinchFocal;
    const zoomed = zoomAt(this.gestureStart, this.gestureStart.k * scale, x, y);
    this.setCamera({ ...zoomed, tx: zoomed.tx + (fx - x), ty: zoomed.ty + (fy - y) });
  }

  pinchEnd() {
    if (this.selectedId) this.invalidate();
  }

  tap(x: number, y: number) {
    if (this.opts.mode === "force") {
      if (!this.layout) return;
      const w = screenToWorld(this.cam, x, y);
      const hit = hitNode(this.layout.nodes, w.x, w.y, this.cam.k);
      if (hit) {
        haptics.selection();
        this.setSelected(hit.id);
        this.onSelectNode?.({ id: hit.id, type: hit.node.type });
      } else {
        this.setSelected(null);
      }
      return;
    }
    if (!this.root || !this.focus) return;
    const arcs = computeArcs(this.root, this.current, this.focus, this.geom, this.maxR());
    const hit = hitRadial(arcs, this.geom.innerR - 3, x - this.w / 2, y - this.centerY());
    if (!hit) return;
    if (hit.kind === "hub") {
      if (this.focus !== this.root) {
        haptics.selection();
        this.zoomTo(this.focus.parent ?? this.root);
      }
      return;
    }
    const d = hit.node;
    haptics.selection();
    if (d.data.type !== "workspace" && d.data.type !== "branch") {
      this.onSelectNode?.({ id: d.data.id, type: d.data.type });
    }
    if (hasChildren(d)) this.zoomTo(d);
  }

  private zoomTo(node: RNode) {
    if (!this.root || !this.focus) return;
    const fromGeom = this.geom;
    const from = new Map(this.current);
    this.focus = node;
    const toGeom = restingGeom(this.root, node, this.maxR());
    const to = targetArcs(this.root, node);
    if (this.opts.reducedMotion) {
      this.current = to;
      this.geom = toGeom;
      this.radialAnim = null;
      this.invalidate();
      return;
    }
    this.radialAnim = { from, to, fromGeom, toGeom, start: performance.now() };
    this.schedule();
  }

  // ── frame loop ─────────────────────────────────────────────────────────────

  private invalidate() {
    this.dirty = true;
    this.schedule();
  }

  private schedule() {
    if (this.raf || !this.active || this.disposed || this.w === 0) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private stopLoop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.active || this.disposed) return;
    let more = false;

    if (this.layout) {
      const pinned = this.grabbed !== null;
      if (!this.layout.done() || pinned) {
        this.layout.tick(TICKS_PER_FRAME);
        this.dirty = true;
        more = true;
        // Fit once the layout looks settled, rather than waiting out the slow tail.
        if (!this.didAutoFit && !this.userInteracted && this.layout.alpha() <= VISUALLY_SETTLED_ALPHA) {
          this.didAutoFit = true;
          this.fit(true);
        }
      } else if (!this.didAutoFit && !this.userInteracted) {
        this.didAutoFit = true;
        this.fit(true);
      }
    }

    if (this.camAnim) {
      const t = Math.min(1, (now - this.camAnim.start) / FIT_MS);
      this.setCamera(lerpCamera(this.camAnim.from, this.camAnim.to, easeCubicInOut(t)));
      if (t >= 1) this.camAnim = null;
      else more = true;
    }

    if (this.radialAnim) {
      const a = this.radialAnim;
      const t = Math.min(1, (now - a.start) / RADIAL_MS);
      const r = interpolateArcs(a.from, a.to, a.fromGeom, a.toGeom, t);
      this.current = r.arcs;
      this.geom = r.geom;
      this.dirty = true;
      if (t >= 1) {
        this.current = a.to;
        this.geom = a.toGeom;
        this.radialAnim = null;
      } else {
        more = true;
      }
    }

    if (this.dirty) {
      this.dirty = false;
      this.record();
    }
    if (more) this.schedule();
  };

  private record() {
    if (this.w === 0) return;
    if (this.opts.mode === "force" && this.layout) {
      this.cb.onPicture(
        recordForceScene({
          t: this.theme,
          nodes: this.layout.nodes,
          links: this.layout.links,
          labelMode: this.opts.labelMode,
          showHulls: this.opts.showHulls,
          zoom: this.cam.k,
          selectedId: this.selectedId,
        }),
      );
    } else if (this.opts.mode === "radial" && this.root && this.focus) {
      const arcs = computeArcs(this.root, this.current, this.focus, this.geom, this.maxR());
      this.cb.onPicture(
        recordRadialScene({
          t: this.theme,
          width: this.w,
          height: this.h,
          cx: this.w / 2,
          cy: this.centerY(),
          arcs,
          geom: this.geom,
          focus: this.focus,
          isRoot: this.focus === this.root,
        }),
      );
    }
  }
}
