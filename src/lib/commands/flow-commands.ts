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
      const created = await window.electron?.flow.node.create({
        projectId,
        type: rfNode.type,
        x: rfNode.position.x,
        y: rfNode.position.y,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: rfNode.data as any,
      }) as { id: string } | undefined;
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
      const created = await window.electron?.flow.node.create({
        projectId,
        type: rfNode.type,
        x: rfNode.position.x,
        y: rfNode.position.y,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: rfNode.data as any,
      }) as { id: string } | undefined;
      const id = created?.id ?? rfNode.id;
      flowHandlers.addNode?.({ ...rfNode, id });
    },
    async redo() {
      await window.electron?.flow.node.delete(rfNode.id);
      flowHandlers.removeNode?.(rfNode.id);
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
