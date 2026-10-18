import { Platform } from "react-native";
import { Skia, PaintStyle, StrokeJoin, matchFont, type SkPicture, type SkPaint, type SkFont, type SkCanvas, type SkPathBuilder } from "@shopify/react-native-skia";
import { withAlpha, type Theme } from "@/theme";
import {
  edgeStyle,
  shouldShowLabel,
  labelScreenPx,
  labelMaxLen,
  sunburstTypeToken,
  type LabelMode,
} from "@cairn/shared/ui/graph";
import { nodeTypeColor, tokenColor } from "./colors";
import type { SimNode, SimLink } from "./layout";
import { hullPaths } from "./hulls";
import { arcPath, hasChildren, type DrawArc, type RNode, type RingGeom } from "./radial";

const WORLD = Skia.XYWHRect(-20000, -20000, 40000, 40000);
const FAMILY = Platform.select({ ios: "Helvetica", default: "sans-serif" });

let fontCache: { regular: Record<number, SkFont>; bold: Record<number, SkFont> } | null = null;
/** System fonts by size/weight, created lazily and reused across frames. */
function font(size: number, bold: boolean): SkFont {
  fontCache ??= { regular: {}, bold: {} };
  const bucket = bold ? fontCache.bold : fontCache.regular;
  return (bucket[size] ??= matchFont({ fontFamily: FAMILY, fontSize: size, fontWeight: bold ? "600" : "normal" }));
}

function paint(color: string, style: PaintStyle = PaintStyle.Fill, width = 0): SkPaint {
  const p = Skia.Paint();
  p.setAntiAlias(true);
  p.setStyle(style);
  p.setColor(Skia.Color(color));
  if (width) p.setStrokeWidth(width);
  return p;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Text with a background-coloured halo so labels stay legible over edges. */
function haloText(c: SkCanvas, text: string, x: number, y: number, f: SkFont, fill: SkPaint, halo: SkPaint) {
  c.drawText(text, x, y, halo, f);
  c.drawText(text, x, y, fill, f);
}

export interface ForceSceneInput {
  t: Theme;
  nodes: readonly SimNode[];
  links: readonly SimLink[];
  labelMode: LabelMode;
  showHulls: boolean;
  zoom: number;
  selectedId: string | null;
}

/** Record the force graph in world coordinates; the camera transforms it. */
export function recordForceScene(s: ForceSceneInput): SkPicture {
  const { t, nodes, links } = s;
  const rec = Skia.PictureRecorder();
  const c = rec.beginRecording(WORLD);

  // cluster hulls
  if (s.showHulls) {
    const members = new Map<string, SimNode[]>();
    const projects = new Set(nodes.filter((n) => n.node.type === "project").map((n) => n.id));
    for (const n of nodes) {
      const pid = n.node.type === "project" ? n.id : n.node.projectId;
      if (!pid || !projects.has(pid)) continue;
      (members.get(pid) ?? members.set(pid, []).get(pid)!).push(n);
    }
    const fill = paint(withAlpha(t.accent, 0.05));
    const stroke = paint(withAlpha(t.accent, 0.18), PaintStyle.Stroke, 1.2);
    for (const d of hullPaths(members)) {
      const path = Skia.Path.MakeFromSVGString(d);
      if (!path) continue;
      c.drawPath(path, fill);
      c.drawPath(path, stroke);
    }
  }

  // edges — one path per visual style so a few thousand edges are a handful of draws
  const batches = new Map<string, { p: SkPaint; path: SkPathBuilder }>();
  for (const l of links) {
    const st = edgeStyle(l.edge.type);
    let width = 1;
    if (l.edge.type === "semantic" && (l.edge.weight ?? 1) < 1) width = 0.5 + (l.edge.weight ?? 0);
    const key = `${st.token}|${st.opacity}|${st.dash}|${width}`;
    let b = batches.get(key);
    if (!b) {
      const p = paint(withAlpha(tokenColor(st.token, t), st.opacity), PaintStyle.Stroke, width);
      if (st.dash) p.setPathEffect(Skia.PathEffect.MakeDash([3, 3], 0));
      b = { p, path: Skia.PathBuilder.Make() };
      batches.set(key, b);
    }
    b.path.moveTo(l.source.x, l.source.y);
    b.path.lineTo(l.target.x, l.target.y);
  }
  for (const b of batches.values()) c.drawPath(b.path.detach(), b.p);

  // nodes
  const fills = new Map<string, SkPaint>();
  for (const n of nodes) {
    const col = nodeTypeColor(n.node.type, t);
    let p = fills.get(col);
    if (!p) fills.set(col, (p = paint(withAlpha(col, 0.92))));
    c.drawCircle(n.x, n.y, n.r, p);
  }
  const sel = s.selectedId ? nodes.find((n) => n.id === s.selectedId) : undefined;
  if (sel) {
    const ring = paint(t.textPrimary, PaintStyle.Stroke, 1.8 / s.zoom);
    c.drawCircle(sel.x, sel.y, sel.r + 2.5 / s.zoom, ring);
  }

  // labels (level-of-detail by zoom, same rule as desktop)
  const halo = paint(t.background, PaintStyle.Stroke, 3);
  halo.setStrokeJoin(StrokeJoin.Round);
  const primary = paint(t.textPrimary);
  const secondary = paint(t.textSecondary);
  for (const n of nodes) {
    const isSel = n.id === s.selectedId;
    if (!shouldShowLabel({ type: n.node.type, isSelected: isSel, isHovered: false, labelMode: s.labelMode, zoom: s.zoom })) continue;
    const isProject = n.node.type === "project";
    const px = labelScreenPx(n.node.type);
    const f = font(px, isProject);
    const text = truncate(n.node.title, labelMaxLen(n.node.type, isSel));
    const w = f.measureText(text).width;
    haloText(c, text, n.x - w / 2, n.y + n.r + 4 + px, f, isProject ? primary : secondary, halo);
  }

  return rec.finishRecordingAsPicture();
}

export interface RadialSceneInput {
  t: Theme;
  width: number;
  /** Centre of the circle, in canvas px (below any floating controls). */
  cx: number;
  cy: number;
  height: number;
  arcs: readonly DrawArc[];
  geom: RingGeom;
  focus: RNode;
  isRoot: boolean;
}

/** Record the sunburst in screen coordinates (no camera: radial drills in). */
export function recordRadialScene(s: RadialSceneInput): SkPicture {
  const { t } = s;
  const rec = Skia.PictureRecorder();
  const c = rec.beginRecording(Skia.XYWHRect(0, 0, s.width, s.height));
  c.translate(s.cx, s.cy);

  const edge = paint(t.background, PaintStyle.Stroke, 1);
  for (const a of s.arcs) {
    const isBranch = a.node.depth === s.focus.depth + 1 && hasChildren(a.node);
    const col = tokenColor(sunburstTypeToken(a.node.data.type), t);
    const path = Skia.Path.MakeFromSVGString(arcPath(a.x0, a.x1, a.r0, a.r1));
    if (!path) continue;
    c.drawPath(path, paint(withAlpha(col, isBranch ? 1 : 0.62)));
    c.drawPath(path, edge);
  }

  // wedge labels — branches centred in their ring, leaves running outward
  const onBranch = paint(t.accentFg);
  const onLeaf = paint(t.textPrimary);
  for (const a of s.arcs) {
    const isBranch = a.node.depth === s.focus.depth + 1 && hasChildren(a.node);
    const span = a.x1 - a.x0;
    if (!(isBranch || (span * a.r0 >= 9 && span > 0.012 && a.r1 - a.r0 > 12))) continue;
    const ang = (a.x0 + a.x1) / 2;
    const flip = ang >= Math.PI;
    const px = isBranch ? 12 : 11;
    const f = font(px, isBranch);
    const maxChars = Math.max(2, Math.floor((a.r1 - a.r0 - 8) / (px * 0.58)));
    const text = truncate(a.node.data.title, maxChars);
    const w = f.measureText(text).width;
    const rot = ((ang - Math.PI / 2) * 180) / Math.PI;
    c.save();
    c.rotate(rot, 0, 0);
    if (isBranch) {
      c.translate((a.r0 + a.r1) / 2, 0);
      if (flip) c.rotate(180, 0, 0);
      c.drawText(text, -w / 2, px * 0.35, onBranch, f);
    } else if (flip) {
      c.translate(a.r1 - 4, 0);
      c.rotate(180, 0, 0);
      c.drawText(text, 0, px * 0.35, onLeaf, f);
    } else {
      c.translate(a.r0 + 4, 0);
      c.drawText(text, 0, px * 0.35, onLeaf, f);
    }
    c.restore();
  }

  // hub — focus label + back affordance
  const hubR = s.geom.innerR - 3;
  c.drawCircle(0, 0, hubR, paint(withAlpha(t.surface, 0.95)));
  c.drawCircle(0, 0, hubR, s.isRoot ? paint(t.border, PaintStyle.Stroke, 1) : paint(withAlpha(t.accent, 0.5), PaintStyle.Stroke, 1.5));
  if (s.isRoot) {
    const f = font(11, true);
    const text = "Workspace";
    c.drawText(text, -f.measureText(text).width / 2, 4, paint(t.textSecondary), f);
  } else {
    const f = font(14, true);
    const title = truncate(s.focus.data.title, 18);
    c.drawText(title, -f.measureText(title).width / 2, -4, paint(t.textPrimary), f);
    const f2 = font(11, false);
    const back = "← back";
    c.drawText(back, -f2.measureText(back).width / 2, 16, paint(withAlpha(t.accent, 0.9)), f2);
  }

  return rec.finishRecordingAsPicture();
}
