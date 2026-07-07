/**
 * Shared knowledge-graph layout + styling logic — pure data/functions with no
 * React, no D3, and no platform theme deps, so the desktop canvas
 * (ForceGraphCanvas) and the mobile WebView (KnowledgeGraphWebView) render the
 * SAME force layout, node radii, edge styling and label-visibility rules from a
 * single source of truth.
 *
 * Colours are expressed as semantic *theme tokens* ("accent" | "info" | ...).
 * Each platform maps a token to a concrete colour: desktop → `var(--token)`
 * CSS variables, mobile → `Theme[token]` values.
 */

export type GraphNodeType = "project" | "note" | "card" | "tag";

export type GraphEdgeType =
  | "note-note" | "note-card" | "tag-member" | "project-member"
  | "flow-ref" | "flow-edge" | "co-mention" | "keyword" | "assignee"
  | "wikilink" | "semantic";

/** Semantic colour token — resolved per-platform to a real colour. */
export type ThemeToken =
  | "accent" | "info" | "success" | "warning" | "border"
  | "background" | "textPrimary" | "textSecondary" | "textTertiary";

// ── node styling ─────────────────────────────────────────────────────────────

/** Node type → colour token. Tags render in the TYPE (warning) colour — never
 *  their own tag colour — so the legend keys stay meaningful. */
export function nodeTypeToken(type: GraphNodeType): ThemeToken {
  switch (type) {
    case "project": return "accent";
    case "note":    return "info";
    case "card":    return "success";
    case "tag":     return "warning";
  }
}

/** Node radius by type. Mirrors desktop radiusOf(): project 9, tag 4.5, else 6. */
export function nodeRadius(type: GraphNodeType): number {
  return type === "project" ? 9 : type === "tag" ? 4.5 : 6;
}

// ── edge styling ─────────────────────────────────────────────────────────────

export interface EdgeStyle {
  token: ThemeToken;
  opacity: number;
  dash: boolean;
}

/** Edge type → colour token, opacity and dash. Mirrors desktop edgeColor(). */
export function edgeStyle(type: string): EdgeStyle {
  switch (type) {
    case "note-note":      return { token: "info",    opacity: 0.6,  dash: false };
    case "note-card":      return { token: "success", opacity: 0.6,  dash: false };
    case "tag-member":     return { token: "warning", opacity: 0.5,  dash: false };
    case "project-member": return { token: "accent",  opacity: 0.35, dash: false };
    case "flow-edge":      return { token: "accent",  opacity: 0.8,  dash: false };
    case "flow-ref":       return { token: "accent",  opacity: 0.5,  dash: true  };
    case "co-mention":     return { token: "border",  opacity: 0.5,  dash: true  };
    case "keyword":        return { token: "border",  opacity: 0.4,  dash: true  };
    case "assignee":       return { token: "border",  opacity: 0.4,  dash: true  };
    case "wikilink":       return { token: "accent",  opacity: 0.75, dash: false };
    case "semantic":       return { token: "accent",  opacity: 0.5,  dash: true  };
    default:               return { token: "border",  opacity: 0.4,  dash: false };
  }
}

// ── force simulation (all values assume spacing = 1) ─────────────────────────

/** Radial project-cluster anchor radius (× spacing). */
export const CLUSTER_RADIUS = 230;

/** Many-body charge strength for a node given its degree (× spacing, except
 *  orphans). Mirrors desktop chargeFor(). */
export function chargeStrength(type: GraphNodeType, degree: number, spacing = 1): number {
  if (degree === 0) return -20;
  return (type === "project" ? -260 : -130) * spacing;
}

/** Link distance for an edge type (× spacing). Mirrors desktop linkDist(). */
export function linkDistance(edgeType: string, spacing = 1): number {
  let b = 42;
  if (edgeType === "project-member") b = 64;
  if (edgeType === "tag-member") b = 54;
  return b * spacing;
}

/** Link force strength — constant across edge types. */
export const LINK_STRENGTH = 0.35;

/** Collision radius for a node (× spacing). */
export function collideRadius(type: GraphNodeType, spacing = 1): number {
  return (nodeRadius(type) + 12) * spacing;
}
export const COLLIDE_ITERATIONS = 2;

/** forceX / forceY anchor strength pulling a node toward its cluster centre. */
export function anchorStrength(type: GraphNodeType, hasProject: boolean): number {
  return type === "project" ? 0.25 : hasProject ? 0.14 : 0.03;
}

export const ALPHA_DECAY = 0.025;
export const VELOCITY_DECAY = 0.4;

// ── label visibility (zoom-dependent) ────────────────────────────────────────

export type LabelMode = "smart" | "all" | "minimal";

/**
 * Whether a node's label should render at the current zoom `k`. Mirrors the
 * desktop rule: projects + selected/hovered nodes always show; otherwise
 * "all" reveals at k ≥ 0.7 and "smart" at k ≥ 1.5 ("minimal" only shows the
 * always-on set).
 */
export function shouldShowLabel(opts: {
  type: GraphNodeType;
  isSelected: boolean;
  isHovered: boolean;
  labelMode: LabelMode;
  zoom: number;
}): boolean {
  const { type, isSelected, isHovered, labelMode, zoom } = opts;
  if (type === "project" || isSelected || isHovered) return true;
  if (labelMode === "all") return zoom >= 0.7;
  if (labelMode === "smart") return zoom >= 1.5;
  return false;
}

/** On-screen label font size (before dividing by zoom). */
export function labelScreenPx(type: GraphNodeType): number {
  return type === "project" ? 12 : 10;
}

/** Max label length before truncation. */
export function labelMaxLen(type: GraphNodeType, isHighlight: boolean): number {
  return isHighlight ? 60 : type === "project" ? 26 : 18;
}

// ── radial / sunburst hierarchy ──────────────────────────────────────────────

export const SUNBURST_ROOT_ID = "__workspace__";
export const SUNBURST_TAGS_BRANCH_ID = "__tags__";
export const SUNBURST_ORPHAN_BRANCH_ID = "__orphans__";

/** A node in the sunburst hierarchy. `type` is a GraphNodeType or a synthetic
 *  "branch" / "workspace" grouping type. */
export interface HierarchyNode {
  id: string;
  title: string;
  type: GraphNodeType | "branch" | "workspace";
  children?: HierarchyNode[];
}

/** Minimal graph shape the hierarchy builder needs (platform-agnostic). */
export interface HierarchyInput {
  nodes: Array<{ id: string; type: GraphNodeType; title: string; projectId?: string }>;
}

/**
 * Build the sunburst hierarchy shared by desktop RadialTreeCanvas and the
 * mobile radial renderer:
 *   root → projects → (notes | cards)
 *   root → "Other" branch → notes/cards with no present project
 *   root → "Tags" branch → tags (each once, shared across the workspace)
 */
export function buildHierarchy(graph: HierarchyInput): HierarchyNode {
  const projects = graph.nodes.filter((n) => n.type === "project");
  const byProject = new Map<string, HierarchyNode>();
  const orphans: HierarchyNode[] = [];

  for (const p of projects) {
    byProject.set(p.id, { id: p.id, title: p.title ?? "", type: "project", children: [] });
  }

  for (const n of graph.nodes) {
    if (n.type !== "note" && n.type !== "card") continue;
    const parent = n.projectId ? byProject.get(n.projectId) : null;
    if (parent) {
      parent.children!.push({ id: n.id, title: n.title ?? "", type: n.type });
    } else {
      orphans.push({ id: n.id, title: n.title ?? "", type: n.type });
    }
  }

  const tagNodes = graph.nodes.filter((n) => n.type === "tag");
  const children: HierarchyNode[] = [...byProject.values()];
  if (orphans.length) {
    children.push({ id: SUNBURST_ORPHAN_BRANCH_ID, title: "Other", type: "branch", children: orphans });
  }
  if (tagNodes.length) {
    children.push({
      id: SUNBURST_TAGS_BRANCH_ID,
      title: "Tags",
      type: "branch",
      children: tagNodes.map((t) => ({ id: t.id, title: t.title ?? "", type: "tag" as const })),
    });
  }

  return { id: SUNBURST_ROOT_ID, title: "Workspace", type: "workspace", children };
}

/** Sunburst node type → colour token. Branch/workspace groupings use secondary. */
export function sunburstTypeToken(type: HierarchyNode["type"]): ThemeToken {
  switch (type) {
    case "project": return "accent";
    case "note":    return "info";
    case "card":    return "success";
    case "tag":     return "warning";
    case "branch":
    case "workspace": return "textSecondary";
    default: return "textTertiary";
  }
}

