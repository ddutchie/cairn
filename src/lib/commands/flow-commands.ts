/**
 * Cairn — Idea Flow undo/redo commands
 *
 * Flow commands call window.electron.flow.* IPC directly (the flow view
 * bypasses Zustand) and also call flowHandlers.* to patch local React Flow
 * state without a full DB re-fetch, preventing canvas flicker.
 */

import type { Edge, Node } from "@xyflow/react";
import type { Command } from "@/lib/history";
import { flowHandlers } from "@/lib/history";
import type { TaskCard } from "@/types";

// Strip resolved/computed fields that are added at read time and are not
// stored in the DB. Passing them to flow.node.create causes IPC clone errors.
const RESOLVED_KEYS = new Set(["resolvedTitle", "resolvedSnippet", "resolvedPriority", "resolvedColumnName"]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeNodeData(data: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(data).filter(([k]) => !RESOLVED_KEYS.has(k)));
}

// ── Command factories ──────────────────────────────────────────────────────────

export function makeAddNodeCmd(
  rfNode: Node,
  projectId: string,
): Command {
  return {
    label: `Add ${rfNode.type ?? "node"} to flow`,
    async undo() {
      await window.electron?.flow.node.delete(rfNode.id);
      flowHandlers.removeNode?.(rfNode.id);
    },
    async redo() {
      const created = await window.electron?.flow.node.create(JSON.parse(JSON.stringify({
        projectId,
        type: rfNode.type,
        x: rfNode.position.x,
        y: rfNode.position.y,
        data: sanitizeNodeData(rfNode.data as Record<string, unknown>),
      }))) as { id: string } | undefined;
      // If the server reuses the same id (it won't — ids are generated
      // server-side), fall back to rfNode.id for the local state update.
      const id = created?.id ?? rfNode.id;
      flowHandlers.addNode?.({ ...rfNode, id });
    },
  };
}

export function makeUpdateNodeCmd(
  nodeId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prevData: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  newData: Record<string, any>,
): Command {
  return {
    label: `Edit flow node`,
    async undo() {
      await window.electron?.flow.node.update(nodeId, { data: prevData });
      flowHandlers.updateNode?.(nodeId, prevData);
    },
    async redo() {
      await window.electron?.flow.node.update(nodeId, { data: newData });
      flowHandlers.updateNode?.(nodeId, newData);
    },
  };
}

export function makeDeleteNodeCmd(
  rfNode: Node,
  projectId: string,
): Command {
  return {
    label: `Delete flow node`,
    async undo() {
      const created = await window.electron?.flow.node.create(JSON.parse(JSON.stringify({
        projectId,
        type: rfNode.type,
        x: rfNode.position.x,
        y: rfNode.position.y,
        width:    (rfNode.style?.width  as number | undefined) ?? rfNode.measured?.width,
        height:   (rfNode.style?.height as number | undefined) ?? rfNode.measured?.height,
        parentId: rfNode.parentId,
        data: sanitizeNodeData(rfNode.data as Record<string, unknown>),
      }))) as { id: string } | undefined;
      const id = created?.id ?? rfNode.id;
      flowHandlers.addNode?.({ ...rfNode, id });
    },
    async redo() {
      await window.electron?.flow.node.delete(rfNode.id);
      flowHandlers.removeNode?.(rfNode.id);
    },
  };
}

/**
 * Compound delete command for a group and all its children deleted together.
 * Undo restores the group first (so children can reference it), then children.
 * Redo deletes the group (which cascades children in the DB).
 */
export function makeDeleteGroupCmd(
  group: Node,
  children: Node[],
  projectId: string,
): Command {
  return {
    label: `Delete group`,
    async undo() {
      // Restore group first
      const createdGroup = await window.electron?.flow.node.create(JSON.parse(JSON.stringify({
        projectId,
        type: group.type,
        x: group.position.x,
        y: group.position.y,
        width:  (group.style?.width  as number | undefined) ?? group.measured?.width,
        height: (group.style?.height as number | undefined) ?? group.measured?.height,
        data: sanitizeNodeData(group.data),
      }))) as { id: string } | undefined;
      const groupId = createdGroup?.id ?? group.id;
      flowHandlers.addNode?.({ ...group, id: groupId });

      // Restore children with parentId pointing to the new group id
      for (const child of children) {
        const createdChild = await window.electron?.flow.node.create(JSON.parse(JSON.stringify({
          projectId,
          type: child.type,
          x: child.position.x,
          y: child.position.y,
          parentId: groupId,
          data: sanitizeNodeData(child.data as Record<string, unknown>),
        }))) as { id: string } | undefined;
        const childId = createdChild?.id ?? child.id;
        flowHandlers.addNode?.({ ...child, id: childId, parentId: groupId });
      }
    },
    async redo() {
      // parent_id uses ON DELETE SET NULL, so explicitly delete children first
      for (const child of children) {
        await window.electron?.flow.node.delete(child.id);
        flowHandlers.removeNode?.(child.id);
      }
      await window.electron?.flow.node.delete(group.id);
      flowHandlers.removeNode?.(group.id);
    },
  };
}

export function makeAddEdgeCmd(
  rfEdge: Edge,
  projectId: string,
): Command {
  return {
    label: `Connect flow nodes`,
    async undo() {
      await window.electron?.flow.edge.delete(rfEdge.id);
      flowHandlers.removeEdge?.(rfEdge.id);
    },
    async redo() {
      await window.electron?.flow.edge.create({
        projectId,
        sourceNodeId: rfEdge.source,
        targetNodeId: rfEdge.target,
        label: typeof rfEdge.label === "string" ? rfEdge.label : undefined,
      });
      flowHandlers.addEdge?.(rfEdge);
    },
  };
}

export function makeDeleteEdgeCmd(
  rfEdge: Edge,
  projectId: string,
): Command {
  return {
    label: `Remove flow connection`,
    async undo() {
      await window.electron?.flow.edge.create({
        projectId,
        sourceNodeId: rfEdge.source,
        targetNodeId: rfEdge.target,
        label: typeof rfEdge.label === "string" ? rfEdge.label : undefined,
      });
      flowHandlers.addEdge?.(rfEdge);
    },
    async redo() {
      await window.electron?.flow.edge.delete(rfEdge.id);
      flowHandlers.removeEdge?.(rfEdge.id);
    },
  };
}

/**
 * Undo/redo for dragging a node to a new position (or in/out of a group).
 */
export function makeMoveNodeCmd(
  nodeId: string,
  prevPosition: { x: number; y: number },
  prevParentId: string | undefined,
  newPosition: { x: number; y: number },
  newParentId: string | undefined,
): Command {
  return {
    label: `Move flow node`,
    async undo() {
      await window.electron?.flow.node.update(nodeId, {
        x: prevPosition.x,
        y: prevPosition.y,
        parentId: prevParentId ?? null,
      });
      flowHandlers.moveNode?.(nodeId, prevPosition, prevParentId);
    },
    async redo() {
      await window.electron?.flow.node.update(nodeId, {
        x: newPosition.x,
        y: newPosition.y,
        parentId: newParentId ?? null,
      });
      flowHandlers.moveNode?.(nodeId, newPosition, newParentId);
    },
  };
}

/**
 * Undo/redo for resizing a group node.
 */
export function makeResizeGroupCmd(
  nodeId: string,
  prevWidth: number,
  prevHeight: number,
  newWidth: number,
  newHeight: number,
): Command {
  return {
    label: `Resize group`,
    async undo() {
      await window.electron?.flow.node.update(nodeId, { width: prevWidth, height: prevHeight });
      flowHandlers.resizeNode?.(nodeId, prevWidth, prevHeight);
    },
    async redo() {
      await window.electron?.flow.node.update(nodeId, { width: newWidth, height: newHeight });
      flowHandlers.resizeNode?.(nodeId, newWidth, newHeight);
    },
  };
}

/**
 * Undo/redo for the Arrange (auto-layout) button.
 * Snapshots all node positions before and after.
 */
export function makeAutoLayoutCmd(
  prevNodes: Array<{ id: string; x: number; y: number; width?: number; height?: number }>,
  newNodes: Array<{ id: string; x: number; y: number; width?: number; height?: number }>,
  setNodes: (updater: (ns: Node[]) => Node[]) => void,
): Command {
  return {
    label: `Auto-layout`,
    async undo() {
      for (const n of prevNodes) {
        await window.electron?.flow.node.update(n.id, { x: n.x, y: n.y, ...(n.width ? { width: n.width, height: n.height } : {}) });
      }
      setNodes((ns) => ns.map((n) => {
        const prev = prevNodes.find((p) => p.id === n.id);
        if (!prev) return n;
        return {
          ...n,
          position: { x: prev.x, y: prev.y },
          ...(prev.width ? { style: { ...n.style, width: prev.width, height: prev.height } } : {}),
        };
      }));
    },
    async redo() {
      for (const n of newNodes) {
        await window.electron?.flow.node.update(n.id, { x: n.x, y: n.y, ...(n.width ? { width: n.width, height: n.height } : {}) });
      }
      setNodes((ns) => ns.map((n) => {
        const next = newNodes.find((p) => p.id === n.id);
        if (!next) return n;
        return {
          ...n,
          position: { x: next.x, y: next.y },
          ...(next.width ? { style: { ...n.style, width: next.width, height: next.height } } : {}),
        };
      }));
    },
  };
}

/**
 * Undo/redo for promoting an idea node to a task card.
 * Undo: deletes the task_ref node + card, restores the idea node + edges.
 * Redo: recreates the card + task_ref node + edges.
 */
export function makePromoteToTaskCmd(
  oldIdeaNode: Node,
  newTaskRefNodeId: string,
  createdCard: TaskCard,
  edgesBefore: Edge[],
  projectId: string,
): Command {
  return {
    label: `Promote idea to task`,
    async undo() {
      // Delete the task_ref node and the card
      await window.electron?.flow.node.delete(newTaskRefNodeId);
      await window.electron?.card.delete(createdCard.id);
      flowHandlers.removeNode?.(newTaskRefNodeId);

      // Restore the idea node
      const restored = await window.electron?.flow.node.create(JSON.parse(JSON.stringify({
        projectId,
        type: oldIdeaNode.type,
        x: oldIdeaNode.position.x,
        y: oldIdeaNode.position.y,
        data: sanitizeNodeData(oldIdeaNode.data as Record<string, unknown>),
      }))) as { id: string } | undefined;
      const restoredId = restored?.id ?? oldIdeaNode.id;
      flowHandlers.addNode?.({ ...oldIdeaNode, id: restoredId });

      // Restore edges (remapped to restored node id)
      for (const e of edgesBefore) {
        const src = e.source === newTaskRefNodeId ? restoredId : e.source;
        const tgt = e.target === newTaskRefNodeId ? restoredId : e.target;
        await window.electron?.flow.edge.create({ projectId, sourceNodeId: src, targetNodeId: tgt, label: e.label as string | undefined });
      }
    },
    async redo() {
      // Re-create the card
      const created = await window.electron?.card.create({
        projectId: createdCard.projectId,
        workspaceId: createdCard.workspaceId,
        columnId: createdCard.columnId,
        title: createdCard.title,
        description: createdCard.description,
        priority: createdCard.priority,
      }) as { id: string } | undefined;
      const cardId = created?.id ?? createdCard.id;

      // Delete old idea node if still present
      await window.electron?.flow.node.delete(oldIdeaNode.id).catch(() => {});
      flowHandlers.removeNode?.(oldIdeaNode.id);

      // Create task_ref node
      const newNode = await window.electron?.flow.node.create(JSON.parse(JSON.stringify({
        projectId,
        type: "task_ref",
        x: oldIdeaNode.position.x,
        y: oldIdeaNode.position.y,
        data: { cardId },
      }))) as { id: string } | undefined;
      const newNodeId = newNode?.id ?? newTaskRefNodeId;
      flowHandlers.addNode?.({ ...oldIdeaNode, id: newNodeId, type: "task_ref", data: { cardId } });

      // Re-wire edges
      for (const e of edgesBefore) {
        const src = e.source === oldIdeaNode.id ? newNodeId : e.source;
        const tgt = e.target === oldIdeaNode.id ? newNodeId : e.target;
        await window.electron?.flow.edge.create({ projectId, sourceNodeId: src, targetNodeId: tgt, label: e.label as string | undefined });
      }
    },
  };
}
