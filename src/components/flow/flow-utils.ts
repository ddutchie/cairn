import type { Edge, Node } from "@xyflow/react";
import type { IdeaNodeType, ResolvedIdeaFlow } from "@/types";
import { IdeaNode }      from "./nodes/IdeaNode";
import { NoteRefNode }   from "./nodes/NoteRefNode";
import { TaskRefNode }   from "./nodes/TaskRefNode";
import { GroupNode }     from "./nodes/GroupNode";
import { UrlNode }       from "./nodes/UrlNode";
import { AiSummaryNode } from "./nodes/AiSummaryNode";
import { FlowEdge }      from "./edges/FlowEdge";
import { Lightbulb, FileText, CheckSquare, Link2, Sparkles, Layers } from "lucide-react";
import type React from "react";

// Type registries — defined outside component to prevent remounts
export const EDGE_TYPES = { flow: FlowEdge };
export const DEFAULT_EDGE_OPTIONS: Partial<Edge> = { type: "flow" };
export const NODE_TYPES = {
  idea:       IdeaNode,
  note_ref:   NoteRefNode,
  task_ref:   TaskRefNode,
  url:        UrlNode,
  ai_summary: AiSummaryNode,
  group:      GroupNode,
};

export const CONNECTION_LINE_STYLE = { stroke: "var(--accent)", strokeWidth: 1.5, opacity: 0.7 } as const;

// Mappers
export function flowNodeToRF(n: ResolvedIdeaFlow["nodes"][number]): Node {
  const isGroup = n.type === "group";
  return {
    id: n.id,
    type: n.type,
    position: { x: n.x, y: n.y },
    ...(n.parentId ? { parentId: n.parentId, extent: "parent" as const } : {}),
    ...(isGroup ? {
      style: {
        width:  n.width  ?? 320,
        height: n.height ?? 200,
      },
      zIndex: -1,
    } : {}),
    data: {
      ...n.data,
      ...(n.resolvedTitle      ? { resolvedTitle: n.resolvedTitle }           : {}),
      ...(n.resolvedSnippet    ? { resolvedSnippet: n.resolvedSnippet }       : {}),
      ...(n.resolvedPriority   ? { resolvedPriority: n.resolvedPriority }     : {}),
      ...(n.resolvedColumnName ? { resolvedColumnName: n.resolvedColumnName } : {}),
    },
  };
}

export function flowEdgeToRF(e: ResolvedIdeaFlow["edges"][number]): Edge {
  return {
    id: e.id,
    source: e.sourceNodeId,
    target: e.targetNodeId,
    label: e.label ?? undefined,
    type: "flow",
  };
}

export function defaultData(type: IdeaNodeType): Record<string, unknown> {
  switch (type) {
    case "idea":       return { title: "New idea", body: "" };
    case "note_ref":   return { noteId: "" };
    case "task_ref":   return { cardId: "" };
    case "url":        return { url: "", title: "", description: "" };
    case "ai_summary": return { content: "" };
    case "group":      return { label: "Group", color: "accent" };
  }
}

export const ADD_NODE_MENU: Array<{ type: IdeaNodeType; label: string; icon: React.ElementType }> = [
  { type: "idea",       label: "Idea",        icon: Lightbulb   },
  { type: "note_ref",   label: "Note",         icon: FileText    },
  { type: "task_ref",   label: "Task",         icon: CheckSquare },
  { type: "url",        label: "URL",          icon: Link2       },
  { type: "ai_summary", label: "AI Summary",   icon: Sparkles    },
  { type: "group",      label: "Group",        icon: Layers      },
];

/**
 * Given the current React Flow nodes, compute which non-group nodes should
 * belong to which group based on whether the node's center falls inside the
 * group's bounding box. Returns a list of assignments to apply.
 */
export function computeGroupAssignments(nodes: Node[]): Array<{
  nodeId: string;
  parentId: string | null;
  x: number;
  y: number;
}> {
  const groups = nodes.filter((n) => n.type === "group");

  const absPos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    if (!n.parentId) absPos.set(n.id, { x: n.position.x, y: n.position.y });
  }
  for (const n of nodes) {
    if (n.parentId) {
      const parent = absPos.get(n.parentId);
      if (parent) absPos.set(n.id, { x: parent.x + n.position.x, y: parent.y + n.position.y });
      else absPos.set(n.id, { x: n.position.x, y: n.position.y });
    }
  }

  const changes: ReturnType<typeof computeGroupAssignments> = [];

  for (const node of nodes) {
    if (node.type === "group") continue;

    const abs = absPos.get(node.id);
    if (!abs) continue;
    const nodeW = node.measured?.width  ?? 220;
    const nodeH = node.measured?.height ?? 80;
    const cx = abs.x + nodeW / 2;
    const cy = abs.y + nodeH / 2;

    let bestGroup: Node | null = null;
    let bestArea = Infinity;
    for (const g of groups) {
      const gAbs = absPos.get(g.id)!;
      const gw = (g.style?.width  as number) ?? 320;
      const gh = (g.style?.height as number) ?? 200;

      if (cx >= gAbs.x && cx <= gAbs.x + gw && cy >= gAbs.y && cy <= gAbs.y + gh) {
        const area = gw * gh;
        if (area < bestArea) { bestArea = area; bestGroup = g; }
      }
    }

    const newParentId = bestGroup?.id ?? null;
    const currentParentId = node.parentId ?? null;

    if (newParentId === currentParentId) continue;

    if (newParentId) {
      const gAbs = absPos.get(newParentId)!;
      changes.push({ nodeId: node.id, parentId: newParentId, x: abs.x - gAbs.x, y: abs.y - gAbs.y });
    } else {
      changes.push({ nodeId: node.id, parentId: null, x: abs.x, y: abs.y });
    }
  }

  return changes;
}
