/**
 * The people relationship map as a `KnowledgeGraph`, so the Knowledge Graph's
 * force canvas draws it (worker layout, remembered positions, zoom, labels)
 * instead of the People views carrying a renderer of their own. Pure: the
 * link kinds, "me" and former links are expressed as a {@link ForceGraphStyling}.
 */

import type { GraphEdge, GraphNode, KnowledgeGraph } from "../../../shared/types/graph";
import type { GraphEdgeType } from "../../../shared/types/domain";
import type { PersonSummary } from "../../../shared/types/people-view";
import type { ThemeToken } from "../../../shared/ui/graph";
import type { ForceGraphStyling } from "@/components/graph/ForceGraphCanvas";
import { LINK_KIND_LABELS, type LinkKind, type NetworkLink } from "./network";

/** Link kind → the graph edge type that carries it (the layout reads this). */
const EDGE_TYPE: Record<LinkKind, GraphEdgeType> = {
  reporting: "reports-to",
  mentor: "mentor",
  buddy: "partner",
  stakeholder: "stakeholder",
  peer: "partner",
  partner: "partner",
  meeting: "co-mention",
};

/** Link kind → colour token. Kept in step with `LINK_COLOR` (the filter chips). */
export const LINK_TOKEN: Record<LinkKind, ThemeToken> = {
  reporting: "accent",
  mentor: "info",
  buddy: "success",
  stakeholder: "warning",
  peer: "textSecondary",
  partner: "nodePerson",
  meeting: "nodeMeeting",
};

export interface PeopleGraph {
  graph: KnowledgeGraph;
  styling: ForceGraphStyling;
}

/** `people` as person nodes and `links` as edges (weight = meetings together). */
export function buildPeopleGraph(
  people: readonly PersonSummary[],
  links: readonly NetworkLink[],
  meId: string | null,
  workspaceId: string,
  /** A person's own picture: this node is pinned to the centre. */
  focusId: string | null = null,
): PeopleGraph {
  const byId = new Map(people.map((p) => [p.id, p]));
  const nodes: GraphNode[] = people.map((p) => ({ id: p.id, type: "person", title: p.name, workspaceId }));
  const kindOf = new Map<string, NetworkLink>();
  const edges: GraphEdge[] = [];
  for (const l of links) {
    if (!byId.has(l.source) || !byId.has(l.target)) continue;
    kindOf.set(l.id, l);
    edges.push({ id: l.id, source: l.source, target: l.target, type: EDGE_TYPE[l.kind], label: l.label, weight: l.weight });
  }

  const styling: ForceGraphStyling = {
    edge: (e) => {
      const l = kindOf.get(e.id);
      if (!l) return undefined;
      if (l.kind === "meeting") {
        return { token: LINK_TOKEN.meeting, opacity: 0.55, dash: true, width: 0.8 + Math.log2(l.weight + 1) * 0.7 };
      }
      return { token: LINK_TOKEN[l.kind], opacity: l.ended ? 0.45 : 0.85, dash: l.ended, width: 1.5, directed: l.directed };
    },
    node: (n) => {
      if (n.id === focusId) return { token: "accent", radius: 10, label: true, pin: true };
      if (focusId) return n.id === meId ? { label: true } : undefined;
      return n.id === meId ? { token: "accent", radius: 10, label: true } : undefined;
    },
    edgeText: (e) => {
      const l = kindOf.get(e.id);
      return l ? linkText(l, byId.get(l.source)?.name ?? "", byId.get(l.target)?.name ?? "") : undefined;
    },
  };
  return { graph: { nodes, edges }, styling };
}

/** What the source of a directed link is to its target, as on the person page. */
const DIRECTED_VERB: Partial<Record<LinkKind, string>> = {
  reporting: "manages",
  mentor: "mentors",
  buddy: "is buddy to",
  stakeholder: "is a stakeholder for",
};

/** "Ann manages Bo (Reporting line)", "Ann – Bo: Peer", "…: Meetings together, 3 meetings". */
export function linkText(l: NetworkLink, from: string, to: string): string {
  const verb = l.directed ? DIRECTED_VERB[l.kind] : undefined;
  const head = verb ? `${from} ${verb} ${to} (${LINK_KIND_LABELS[l.kind]}${l.label ? `, ${l.label}` : ""})` : `${from} – ${to}: ${LINK_KIND_LABELS[l.kind]}${l.label ? ` (${l.label})` : ""}`;
  const parts = [head];
  if (l.ended) parts.push("former");
  if (l.kind === "meeting") parts.push(`${l.weight} ${l.weight === 1 ? "meeting" : "meetings"}`);
  return parts.join(", ");
}
