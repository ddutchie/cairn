"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { flushSync } from "react-dom";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  ConnectionLineType,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeChange,
  Panel,
} from "@xyflow/react";

import { Plus, LayoutDashboard, Lightbulb, Pencil, Copy, Trash2, ExternalLink, Maximize, Unlink } from "lucide-react";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel,
  ContextMenuSeparator, ContextMenuTrigger, CONTEXT_MENU_DANGER,
} from "@/components/ui/context-menu";
import { revealNote, revealCard } from "@/lib/events";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { IdeaNodeType } from "@/types";
import { flowClient, persistFlow } from "@/lib/ipc/flow";
import { id as newId } from "@/lib/utils";
import { IpcUnavailableError, reportIpcError } from "@/lib/ipc/client";
import { historyManager, flowHandlers } from "@/lib/history";
import { onChangeFeed, feedTouches } from "@/store/change-feed";
import {
  makeAddNodeCmd,
  makeUpdateNodeCmd,
  makeDeleteNodeCmd,
  makeDeleteGroupCmd,
  makeAddEdgeCmd,
  makeDeleteEdgeCmd,
  makeMoveNodeCmd,
  makeResizeGroupCmd,
  makeAutoLayoutCmd,
  makePromoteToTaskCmd,
} from "@/lib/commands/flow-commands";
import { NodeEditModal } from "./NodeEditModal";
import { applyDagreLayout } from "@/lib/flow-layout";
import {
  NODE_TYPES, EDGE_TYPES, DEFAULT_EDGE_OPTIONS, CONNECTION_LINE_STYLE,
  flowNodeToRF, flowEdgeToRF, defaultData, ADD_NODE_MENU, computeGroupAssignments,
} from "./flow-utils";
import { Tooltip } from "@/components/ui/tooltip";

// ── Component ─────────────────────────────────────────────────────────────────


/** Tables whose external changes should reload the open flow. */
const FLOW_TABLES = ["idea_flows", "idea_flow_nodes", "idea_flow_edges", "notes", "task_cards"] as const;
export function IdeaFlowView() {
  return (
    <ReactFlowProvider>
      <IdeaFlowCanvas />
    </ReactFlowProvider>
  );
}

type FlowMenuTarget =
  | { kind: "pane" }
  | { kind: "node"; node: Node }
  | { kind: "edge"; edge: Edge };

function IdeaFlowCanvas() {
  const { activeProjectId, columns, activeWorkspaceId, aiConfig } = useCairnStore(useShallow((s) => ({
    activeProjectId:   s.activeProjectId,
    columns:           s.columns,
    activeWorkspaceId: s.activeWorkspaceId,
    aiConfig:          s.aiConfig,
  })));
  const aiEnabled = aiConfig.aiEnabled ?? true;
  const addNodeMenu = ADD_NODE_MENU.filter((n) => n.type !== "ai_summary" || aiEnabled);
  const { fitView, screenToFlowPosition, getInternalNode, deleteElements } = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [loading, setLoading]       = useState(true);

  // Detect touch device for mobile-specific interactions
  const isTouchDevice = typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
  const setView = useCairnStore((s) => s.setView);

  // Context menu (Radix): what was right-clicked + where, in screen coords.
  // Touch long-press is handled by Radix itself, so no manual timer.
  const [menuTarget, setMenuTarget] = useState<FlowMenuTarget>({ kind: "pane" });
  const menuPointRef = useRef({ x: 0, y: 0 });

  const [editTarget, setEditTarget] = useState<{
    nodeId: string; type: IdeaNodeType; data: Record<string, unknown>;
  } | null>(null);

  const nodeCountRef = useRef(0);
  const initialLoadDone = useRef(false);
  // Debounce group-resize DB writes so we don't hammer SQLite on every pixel change
  const resizeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Ref to current nodes so resize handler can read them without stale closure
  const nodesRef = useRef<Node[]>([]);
  // Capture position/parentId at drag start for undo
  const dragStartStateRef = useRef<{ position: { x: number; y: number }; parentId: string | undefined } | null>(null);

  // Suppress reloads triggered by our own DB writes so they don't
  // reset React Flow state mid-interaction (e.g. during a connection drag).
  const suppressReloadRef = useRef(false);
  const suppressReloadTimer = useRef<ReturnType<typeof setTimeout>>(null);
  function suppressReload(ms = 1500) {
    suppressReloadRef.current = true;
    if (suppressReloadTimer.current) clearTimeout(suppressReloadTimer.current);
    suppressReloadTimer.current = setTimeout(() => {
      suppressReloadRef.current = false;
    }, ms);
  }

  // Keep nodesRef in sync synchronously (useLayoutEffect) so drag handlers
  // always read the latest nodes without a render cycle delay.
  useLayoutEffect(() => { nodesRef.current = nodes; }, [nodes]);

  // ── Load ──────────────────────────────────────────────────────

  const loadFlow = useCallback(async (isInitial = false) => {
    if (!activeProjectId) return;
    if (isInitial) setLoading(true);
    try {
      const flow = await flowClient.get(activeProjectId);
      nodeCountRef.current = flow.nodes.length;
      // Groups must come before their children in the array for React Flow to parent correctly
      const sorted = [
        ...flow.nodes.filter((n) => n.type === "group"),
        ...flow.nodes.filter((n) => n.type !== "group"),
      ];
      const incoming = sorted.map(flowNodeToRF);

      if (isInitial) {
        // First load: replace everything and fit the viewport
        setNodes(incoming);
        setEdges(flow.edges.map(flowEdgeToRF));
        // Fit after React Flow has measured nodes (next frame)
        setTimeout(() => fitView({ padding: 0.3, duration: 200 }), 50);
        initialLoadDone.current = true;
      } else {
        // Subsequent loads (MCP/AI writes): merge positions to avoid viewport reset.
        // Update existing nodes' data in-place; add new nodes; remove deleted ones.
        setNodes((current) => {
          const currentMap = new Map(current.map((n) => [n.id, n]));
          const merged = incoming.map((n) => {
            const existing = currentMap.get(n.id);
            return existing ? { ...n, position: existing.position } : n;
          });
          return merged;
        });
        setEdges(flow.edges.map(flowEdgeToRF));
      }
    } catch (err) {
      // Background reloads (change feed, after an edit) retry on the next
      // change; only a failed first load is worth a toast.
      if (isInitial) reportIpcError(err, "Couldn't load the Idea Flow");
      else if (!(err instanceof IpcUnavailableError)) console.error("[flow] reload failed", err);
    } finally {
      if (isInitial) setLoading(false);
    }
  }, [activeProjectId, setNodes, setEdges, fitView]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadFlow(true); }, [loadFlow]);

  // Clear the suppress-reload timer on unmount to avoid setting state on a stale ref.
  useEffect(() => {
    return () => { if (suppressReloadTimer.current) clearTimeout(suppressReloadTimer.current); };
  }, []);

  // Register flowHandlers so undo/redo commands can patch local React Flow
  // state without a full DB reload (no flicker).
  useEffect(() => {
    flowHandlers.addNode    = (node) => setNodes((ns) => [...ns.filter((n) => n.id !== node.id), node]);
    flowHandlers.removeNode = (id)   => setNodes((ns) => ns.filter((n) => n.id !== id));
    flowHandlers.updateNode = (id, data) =>
      setNodes((ns) => ns.map((n) => n.id === id ? { ...n, data: { ...n.data, ...data } } : n));
    flowHandlers.moveNode   = (id, position, parentId) =>
      setNodes((ns) => ns.map((n) => n.id === id ? {
        ...n,
        position,
        parentId: parentId ?? undefined,
        extent: parentId ? ("parent" as const) : undefined,
      } : n));
    flowHandlers.resizeNode = (id, width, height) =>
      setNodes((ns) => ns.map((n) => n.id === id ? {
        ...n,
        style: { ...n.style, width, height },
      } : n));
    flowHandlers.addEdge    = (edge) => setEdges((es) => [...es.filter((e) => e.id !== edge.id), edge]);
    flowHandlers.removeEdge = (id)   => setEdges((es) => es.filter((e) => e.id !== id));
    return () => {
      flowHandlers.addNode    = null;
      flowHandlers.removeNode = null;
      flowHandlers.updateNode = null;
      flowHandlers.moveNode   = null;
      flowHandlers.resizeNode = null;
      flowHandlers.addEdge    = null;
      flowHandlers.removeEdge = null;
    };
  }, [setNodes, setEdges]);

  // Re-load on external (MCP/AI/sync/other-window) changes to flow data — but
  // NOT on our own writes. The change feed attributes writes per window, so
  // own drags/edits never reload mid-interaction; the store already clears the
  // undo stack for external changes. Flow nodes can show note/card titles, so
  // those tables count too.
  useEffect(() => {
    return onChangeFeed((e) => {
      if (suppressReloadRef.current) return;
      if (feedTouches(e, FLOW_TABLES, /* external */ true)) loadFlow(false);
    });
  }, [loadFlow]);

  // Close add-menu on outside click

  // ── Connect ───────────────────────────────────────────────────

  const onConnect = useCallback(
    async (params: Connection) => {
      if (!activeProjectId) return;
      suppressReload();
      let edgeId = `${params.source}-${params.target}`;
      try {
        edgeId = (await flowClient.createEdge({
          projectId: activeProjectId,
          sourceNodeId: params.source,
          targetNodeId: params.target,
        })).id;
      } catch (err) {
        reportIpcError(err, "Couldn't connect the nodes");
        return;
      }
      const rfEdge: Edge = { id: edgeId, source: params.source!, target: params.target!, type: "flow" };
      setEdges((eds) => addEdge({ ...rfEdge }, eds));
      historyManager.push(makeAddEdgeCmd(rfEdge, activeProjectId));
    },
    [setEdges, activeProjectId],
  );

  // ── Apply group membership changes ───────────────────────────

  const applyGroupMembership = useCallback((currentNodes: Node[], forcedNodeId?: string) => {
    const changes = computeGroupAssignments(currentNodes);

    // If a node was forced-cleared (dragged node with parentId stripped in currentNodes),
    // but computeGroupAssignments emitted no change (newParentId===null===currentParentId),
    // we must still apply the currentNodes snapshot for that node so its parentId/position
    // are written into React state.
    const changedByCompute = new Set(changes.map((c) => c.nodeId));
    const forcedNode = forcedNodeId ? currentNodes.find((n) => n.id === forcedNodeId) : undefined;

    suppressReload();
    // flushSync ensures React commits the state update synchronously so that
    // nodesRef is up-to-date before any subsequent drag handler fires.
    flushSync(() => setNodes((ns) => {
      const changeMap = new Map(changes.map((c) => [c.nodeId, c]));
      const updated = ns.map((n) => {
        const c = changeMap.get(n.id);
        if (c) {
          return {
            ...n,
            parentId: c.parentId ?? undefined,
            extent: c.parentId ? ("parent" as const) : undefined,
            position: { x: c.x, y: c.y },
          };
        }
        // Force-apply the dragged node's cleared parentId + absolute position
        // even when computeGroupAssignments emitted no change (null→null case).
        if (forcedNode && n.id === forcedNodeId && !changedByCompute.has(n.id)) {
          return {
            ...n,
            parentId: forcedNode.parentId ?? undefined,
            extent: forcedNode.parentId ? ("parent" as const) : undefined,
            position: forcedNode.position,
          };
        }
        // Sync position from currentNodes for the dragged node (no membership change)
        const cur = currentNodes.find((cn) => cn.id === n.id);
        if (cur && cur.position !== n.position) {
          return { ...n, position: cur.position, extent: n.parentId ? ("parent" as const) : undefined };
        }
        return n;
      });
      // Re-sort: groups must come before children
      return [
        ...updated.filter((n) => n.type === "group"),
        ...updated.filter((n) => n.type !== "group"),
      ];
    }));



    // Persist membership changes
    for (const change of changes) {
      persistFlow(flowClient.updateNode(change.nodeId, {
        x: change.x,
        y: change.y,
        parentId: change.parentId ?? null,
      }));
    }
    // Persist the forced node (dragged node leaving a group with no membership change detected)
    if (forcedNode && !changedByCompute.has(forcedNode.id)) {
      persistFlow(flowClient.updateNode(forcedNode.id, {
        x: forcedNode.position.x,
        y: forcedNode.position.y,
        parentId: forcedNode.parentId ?? null,
      }));
    }
    // Persist position for nodes that didn't change membership but were in currentNodes
    // (the dragged node when it stays in the same group or stays ungrouped)
    const changedIds = new Set(changes.map((c) => c.nodeId));
    for (const n of currentNodes) {
      if (!changedIds.has(n.id) && n.id !== forcedNodeId && n.type !== "group") {
        const orig = nodesRef.current.find((o) => o.id === n.id);
        if (orig && (orig.position.x !== n.position.x || orig.position.y !== n.position.y)) {
          persistFlow(flowClient.updateNode(n.id, { x: n.position.x, y: n.position.y }));
        }
      }
    }
  }, [setNodes]);

  // ── Node drag stop — persist position + resolve group membership ──

  const onNodeDragStart = useCallback((_: unknown, node: Node) => {
    // Snapshot position and parentId before the drag for undo
    const internal = getInternalNode(node.id);
    dragStartStateRef.current = {
      position: internal?.internals?.positionAbsolute ?? node.position,
      parentId: node.parentId,
    };
    setNodes((ns) => ns.map((n) => n.id === node.id ? { ...n, extent: undefined } : n));
  }, [setNodes, getInternalNode]);

  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    suppressReload();

    // Use positionAbsolute from RF internals — this is always canvas-space
    // regardless of whether the node has a parentId or extent set.
    const internal = getInternalNode(node.id);
    const absolutePos = internal?.internals?.positionAbsolute ?? node.position;

    // Build current snapshot with the dragged node at its absolute position,
    // parentId cleared so computeGroupAssignments can re-assign from scratch.
    const current = nodesRef.current.map((n) =>
      n.id === node.id
        ? { ...n, position: absolutePos, parentId: undefined, extent: undefined }
        : n
    );

    applyGroupMembership(current, node.id);

    // Push undo command for the position change
    const prevState = dragStartStateRef.current;
    if (prevState) {
      const afterNode = nodesRef.current.find((n) => n.id === node.id);
      const newPos = afterNode?.position ?? absolutePos;
      const newParentId = afterNode?.parentId;
      // Only push if position or parentId actually changed
      if (
        prevState.position.x !== newPos.x ||
        prevState.position.y !== newPos.y ||
        prevState.parentId !== newParentId
      ) {
        historyManager.push(makeMoveNodeCmd(
          node.id,
          prevState.position, prevState.parentId,
          newPos, newParentId,
        ));
      }
      dragStartStateRef.current = null;
    }
  }, [applyGroupMembership, getInternalNode]);

  // ── Handle nodes change — intercept resize to persist size + resolve membership ──

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    onNodesChange(changes);
    for (const change of changes) {
      if (change.type === "dimensions" && change.resizing === false) {
        const { id, dimensions } = change;
        if (!dimensions) continue;
        const existing = resizeTimers.current.get(id);
        if (existing) clearTimeout(existing);
        // Capture size before resize for undo (read from current RF node state)
        const nodeBeforeResize = nodesRef.current.find((n) => n.id === id);
        const prevWidth  = (nodeBeforeResize?.style?.width  as number | undefined) ?? 320;
        const prevHeight = (nodeBeforeResize?.style?.height as number | undefined) ?? 200;
        const timer = setTimeout(() => {
          suppressReload();
          persistFlow(flowClient.updateNode(id, { width: dimensions.width, height: dimensions.height }));
          resizeTimers.current.delete(id);
          historyManager.push(makeResizeGroupCmd(id, prevWidth, prevHeight, dimensions.width, dimensions.height));
          // Check if resize caused nodes to fall inside/outside this group
          applyGroupMembership(nodesRef.current);
        }, 200);
        resizeTimers.current.set(id, timer);
      }
    }
  }, [onNodesChange, applyGroupMembership]);

  // ── Deletions — persist to DB ─────────────────────────────────

  const onEdgesDelete = useCallback((deleted: Edge[]) => {
    suppressReload();
    deleted.forEach((e) => {
      persistFlow(flowClient.deleteEdge(e.id));
      historyManager.push(makeDeleteEdgeCmd(e, activeProjectId ?? ""));
    });
  }, [activeProjectId]);

  const onNodesDelete = useCallback((deleted: Node[]) => {
    suppressReload(1500);

    const deletedGroups = deleted.filter((n) => n.type === "group");
    const deletedNonGroups = deleted.filter((n) => n.type !== "group");

    // For each deleted group, push a compound command covering the group + its
    // children (React Flow deletes children automatically when a group is removed).
    for (const group of deletedGroups) {
      const children = deletedNonGroups.filter((n) => n.parentId === group.id);
      // parent_id is ON DELETE SET NULL, so delete children explicitly before group
      for (const child of children) {
        persistFlow(flowClient.deleteNode(child.id));
      }
      persistFlow(flowClient.deleteNode(group.id));
      historyManager.push(makeDeleteGroupCmd(group, children, activeProjectId ?? ""));
    }

    // Non-group nodes not parented to a deleted group get individual commands.
    const deletedGroupIds = new Set(deletedGroups.map((g) => g.id));
    for (const n of deletedNonGroups) {
      if (deletedGroupIds.has(n.parentId ?? "")) continue; // handled by group cmd
      persistFlow(flowClient.deleteNode(n.id));
      historyManager.push(makeDeleteNodeCmd(n, activeProjectId ?? ""));
    }
  }, [activeProjectId]);

  // ── Double-click node → edit ──────────────────────────────────

  const onNodeDoubleClick: NodeMouseHandler = useCallback((_e, node) => {
    // Group nodes are not editable via modal
    if (node.type === "group") return;
    setEditTarget({ nodeId: node.id, type: node.type as IdeaNodeType, data: node.data as Record<string, unknown> });
  }, [setEditTarget]);

  // ── Context menu ──────────────────────────────────────────────
  // Radix opens the menu from the wrapper's contextmenu event; these handlers
  // (fired first by React Flow) only record which target the menu is for.

  const onNodeContextMenu: NodeMouseHandler = useCallback((_e, node) => {
    setMenuTarget({ kind: "node", node });
  }, []);

  const onEdgeContextMenu = useCallback((_e: React.MouseEvent, edge: Edge) => {
    setMenuTarget({ kind: "edge", edge });
  }, []);

  const rememberMenuPoint = useCallback((e: React.MouseEvent | React.PointerEvent) => {
    menuPointRef.current = { x: e.clientX, y: e.clientY };
    setMenuTarget({ kind: "pane" });
  }, []);

  // ── Add node ──────────────────────────────────────────────────

  async function addNode(type: IdeaNodeType, x = 200, y = 200) {
    if (!activeProjectId) return;
    const data = defaultData(type);
    // Group nodes get a default size and render behind all other nodes
    const isGroup = type === "group";
    const width  = isGroup ? 320 : undefined;
    const height = isGroup ? 200 : undefined;
    suppressReload();
    let created: { id: string };
    try {
      created = await flowClient.createNode({ projectId: activeProjectId, type, x, y, data, width, height });
    } catch (err) {
      reportIpcError(err, "Couldn't add the node");
      return;
    }
    nodeCountRef.current += 1;
    const rfNode: Node = {
      id: created.id,
      type,
      position: { x, y },
      data,
      ...(isGroup ? { style: { width, height }, zIndex: -1 } : {}),
    };
    setNodes((ns) => [...ns, rfNode]);
    // Group nodes need no edit modal on creation
    if (type !== "group") {
      setEditTarget({ nodeId: created.id, type, data: data as Record<string, unknown> });
    }
    historyManager.push(makeAddNodeCmd(rfNode, activeProjectId));
  }

  async function duplicateNode(source: Node) {
    if (!activeProjectId || source.type === "group") return;
    const type = source.type as IdeaNodeType;
    // Drop callbacks injected by nodesWithCallbacks (e.g. onPromote): functions can't cross IPC.
    const data = Object.fromEntries(
      Object.entries(source.data as Record<string, unknown>).filter(([, v]) => typeof v !== "function"),
    ) as ReturnType<typeof defaultData>;
    // Grouped nodes store a position relative to their group; the copy is created
    // ungrouped, so it needs the absolute position.
    const origin = getInternalNode(source.id)?.internals.positionAbsolute ?? source.position;
    const x = origin.x + 32;
    const y = origin.y + 32;
    suppressReload();
    let created: { id: string };
    try {
      created = await flowClient.createNode({ projectId: activeProjectId, type, x, y, data });
    } catch (err) {
      reportIpcError(err, "Couldn't duplicate the node");
      return;
    }
    const rfNode: Node = { id: created.id, type, position: { x, y }, data };
    setNodes((ns) => [...ns, rfNode]);
    historyManager.push(makeAddNodeCmd(rfNode, activeProjectId));
  }

  // ── Save from edit modal ──────────────────────────────────────

  const handleEditSave = useCallback((nodeId: string, data: Record<string, unknown>) => {
    const node = nodes.find((n) => n.id === nodeId);
    const prevData = (node?.data ?? {}) as Record<string, unknown>;
    setNodes((ns) => ns.map((n) => n.id === nodeId ? { ...n, data } : n));
    suppressReload();
    persistFlow(flowClient.updateNode(nodeId, { data }));
    historyManager.push(makeUpdateNodeCmd(nodeId, prevData, data));
    // For ref nodes, reload after save to get resolved title/snippet
    if (node?.type === "note_ref" || node?.type === "task_ref") {
      suppressReloadRef.current = false;
      loadFlow(false);
    }
  }, [setNodes, nodes, loadFlow]);

  // ── Auto-layout ───────────────────────────────────────────────

  const handleAutoLayout = useCallback(async () => {
    if (!activeProjectId) return;
    // Snapshot prev positions for undo
    const prevSnapshot = nodes.map((n) => ({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
      width:  n.type === "group" ? (n.style?.width  as number | undefined) : undefined,
      height: n.type === "group" ? (n.style?.height as number | undefined) : undefined,
    }));
    const laidOut = applyDagreLayout(nodes, edges);
    setNodes(laidOut);
    suppressReload();
    // Persist positions and (for groups) updated sizes
    persistFlow(Promise.all(
      laidOut.map((n) => {
        const isGroup = n.type === "group";
        return flowClient.updateNode(n.id, {
          x: n.position.x,
          y: n.position.y,
          ...(isGroup ? {
            width:  (n.style?.width  as number) ?? undefined,
            height: (n.style?.height as number) ?? undefined,
          } : {}),
        });
      })
    ));
    const newSnapshot = laidOut.map((n) => ({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
      width:  n.type === "group" ? (n.style?.width  as number | undefined) : undefined,
      height: n.type === "group" ? (n.style?.height as number | undefined) : undefined,
    }));
    historyManager.push(makeAutoLayoutCmd(prevSnapshot, newSnapshot, setNodes));
    setTimeout(() => fitView({ padding: 0.3, duration: 300 }), 50);
  }, [nodes, edges, activeProjectId, setNodes, fitView]);

  // ── Promote idea → task ───────────────────────────────────────

  const handlePromoteToTask = useCallback(async (nodeId: string) => {
    if (!activeProjectId || !activeWorkspaceId || !window.electron) return;
    const node = nodes.find((n) => n.id === nodeId);
    if (!node || node.type !== "idea") return;

    // Find first non-done column for this project
    const projectCols = columns
      .filter((c) => c.projectId === activeProjectId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const targetCol = projectCols.find((c) => c.type !== "done") ?? projectCols[0];
    if (!targetCol) return;

    const title = (node.data as Record<string, unknown>).title as string || "New task";
    const body  = (node.data as Record<string, unknown>).body as string | undefined;

    suppressReload();

    // Snapshot edges connected to the old node before deleting it
    const connectedEdges = edges.filter((e) => e.source === nodeId || e.target === nodeId);
    const pos = node.position;

    let created: { id: string };
    let newNode: { id: string };
    try {
      // Create a new task card
      created = await window.electron.card.create({
        id: newId(),
        projectId: activeProjectId,
        workspaceId: activeWorkspaceId,
        columnId: targetCol.id,
        title,
        description: body,
        priority: "medium",
      });

      // Delete the idea node (cascades its DB edges)
      await flowClient.deleteNode(nodeId);

      // Recreate as task_ref at the same position
      newNode = await flowClient.createNode({
        projectId: activeProjectId,
        type: "task_ref",
        x: pos.x,
        y: pos.y,
        data: { cardId: created.id },
      });

      // Re-create the edges that were deleted with the old node
      for (const e of connectedEdges) {
        const src = e.source === nodeId ? newNode.id : e.source;
        const tgt = e.target === nodeId ? newNode.id : e.target;
        await flowClient.createEdge({ projectId: activeProjectId, sourceNodeId: src, targetNodeId: tgt, label: e.label as string | undefined });
      }
    } catch (err) {
      reportIpcError(err, "Couldn't promote the idea to a task");
      // Part of it may have landed; resync the canvas with the DB.
      void loadFlow(false);
      return;
    }

    // Update React Flow state — replace the idea node with a task_ref node
    setNodes((ns) => {
      const filtered = ns.filter((n) => n.id !== nodeId);
      return [...filtered, {
        id: newNode.id,
        type: "task_ref",
        position: pos,
        data: {
          cardId: created.id,
          resolvedTitle: title,
          resolvedPriority: "medium",
          resolvedColumnName: targetCol.name,
        },
      }];
    });
    // Remap edges in React Flow state
    setEdges((es) => {
      const remapped = es
        .filter((e) => e.source !== nodeId && e.target !== nodeId)
        .concat(
          connectedEdges.map((e) => ({
            ...e,
            source: e.source === nodeId ? newNode.id : e.source,
            target: e.target === nodeId ? newNode.id : e.target,
          }))
        );
      return remapped;
    });

    // Push undo command
    const createdCard: import("@/types").TaskCard = {
      id: created.id,
      projectId: activeProjectId,
      workspaceId: activeWorkspaceId,
      columnId: targetCol.id,
      title,
      description: body,
      priority: "medium",
      tagIds: [],
      linkedNoteIds: [],
      blockedByIds: [],
      order: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 0,
    };
    historyManager.push(makePromoteToTaskCmd(node, newNode.id, createdCard, connectedEdges, activeProjectId));
  }, [nodes, edges, setNodes, setEdges, activeProjectId, activeWorkspaceId, columns, loadFlow]);

  // Enrich idea nodes with the onPromote callback so IdeaNode can call it
  const nodesWithCallbacks = useMemo(() =>
    nodes.map((n) =>
      n.type === "idea"
        ? { ...n, data: { ...n.data, onPromote: handlePromoteToTask } }
        : n
    ),
  [nodes, handlePromoteToTask]);

  // ── Guards ────────────────────────────────────────────────────

  if (!activeProjectId) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-[var(--text-tertiary)]">
        Select a project to view its Idea Flow.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-[var(--text-tertiary)]">
        Loading flow…
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────

  return (
    <>
    <ContextMenu>
    <ContextMenuTrigger asChild>
    <div
      data-tutorial="flow-canvas"
      className="flex flex-1 min-h-0"
      style={{ background: "var(--background)" }}
      onPointerDownCapture={rememberMenuPoint}
      onContextMenuCapture={rememberMenuPoint}
      onDoubleClick={(e) => {
        // Desktop: double-click on the pane to add an idea node
        if ((e.target as HTMLElement).classList.contains("react-flow__pane")) {
          const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
          addNode("idea", flowPos.x, flowPos.y);
        }
      }}
    >
      <ReactFlow
        nodes={nodesWithCallbacks}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onEdgesDelete={onEdgesDelete}
        onNodesDelete={onNodesDelete}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeClick={isTouchDevice ? (_e, node) => {
          // Mobile: single tap on a node opens edit modal (no double-tap needed)
          if (node.type === "group") return;
          setEditTarget({ nodeId: node.id, type: node.type as IdeaNodeType, data: node.data as Record<string, unknown> });
        } : undefined}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}

        connectionLineType={ConnectionLineType.Bezier}
        connectionLineStyle={CONNECTION_LINE_STYLE}
        zoomOnDoubleClick={false}
        zoomOnPinch={true}
        panOnDrag={true}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
        <Controls style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10 }} />
        {!isTouchDevice && (
          <MiniMap
            style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}
            nodeColor={(node) => {
              switch (node.type) {
                case "group": {
                  const c = (node.data as Record<string, unknown>).color;
                  if (c === "green")  return "color-mix(in srgb, var(--success) 35%, transparent)";
                  if (c === "orange") return "color-mix(in srgb, var(--warning) 35%, transparent)";
                  if (c === "red")    return "color-mix(in srgb, var(--danger) 35%, transparent)";
                  return "var(--accent-dim)"; // accent + purple both use accent
                }
                case "idea":       return "var(--surface-2)";
                case "note_ref":   return "color-mix(in srgb, var(--info) 40%, transparent)";
                case "task_ref":   return "color-mix(in srgb, var(--success) 40%, transparent)";
                case "url":        return "color-mix(in srgb, var(--warning) 40%, transparent)";
                case "ai_summary": return "color-mix(in srgb, var(--accent) 35%, transparent)";
                default:           return "var(--surface-2)";
              }
            }}
            nodeStrokeWidth={0}
            maskColor="color-mix(in srgb, var(--text-primary) 6%, transparent)"
          />
        )}

        {nodes.length === 0 && (
          <Panel position="top-center">
            <div className="px-6 py-5 rounded-xl bg-[var(--surface)] border border-[var(--border)] shadow-elev-1 pointer-events-none">
              <EmptyState
                icon={Lightbulb}
                title="Your Idea Flow is empty"
                description="Double-click the canvas or use “Add node” to start capturing ideas."
              />
            </div>
          </Panel>
        )}

        <Panel position="top-right">
          <div className="flex items-center gap-2">
            <Tooltip content="Auto-arrange nodes">
              <button
                onClick={handleAutoLayout}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium shadow-elev-1 bg-[var(--surface)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--muted)] transition-colors"
              >
                <LayoutDashboard size={13} />
                Arrange
              </button>
            </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="accent" size="sm">
                <Plus size={13} />
                Add node
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[10rem]">
              {addNodeMenu.map(({ type, label, icon: Icon }) => (
                <DropdownMenuItem key={type} onSelect={() => void addNode(type, 120 + Math.random() * 300, 120 + Math.random() * 200)}>
                  <Icon size={12} className="text-[var(--text-tertiary)]" />
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          </div>
        </Panel>
      </ReactFlow>


    </div>
    </ContextMenuTrigger>
    <ContextMenuContent className="min-w-[180px]">
      {menuTarget.kind === "pane" && (
        <>
          <ContextMenuLabel>Add node</ContextMenuLabel>
          {addNodeMenu.map(({ type, label, icon: Icon }) => (
            <ContextMenuItem
              key={type}
              onSelect={() => {
                const pos = screenToFlowPosition(menuPointRef.current);
                void addNode(type, pos.x, pos.y);
              }}
            >
              <Icon size={13} /> {label}
            </ContextMenuItem>
          ))}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => fitView({ duration: 250 })}>
            <Maximize size={13} /> Fit view
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void handleAutoLayout()}>
            <LayoutDashboard size={13} /> Auto-arrange
          </ContextMenuItem>
        </>
      )}
      {menuTarget.kind === "node" && (() => {
        const node = menuTarget.node;
        const data = node.data as Record<string, unknown>;
        const isGroup = node.type === "group";
        return (
          <>
            {!isGroup && (
              <ContextMenuItem
                onSelect={() => setEditTarget({ nodeId: node.id, type: node.type as IdeaNodeType, data })}
              >
                <Pencil size={13} /> Edit
              </ContextMenuItem>
            )}
            {node.type === "note_ref" && typeof data.noteId === "string" && (
              <ContextMenuItem onSelect={() => revealNote(setView, data.noteId as string)}>
                <ExternalLink size={13} /> Open note
              </ContextMenuItem>
            )}
            {node.type === "task_ref" && typeof data.cardId === "string" && (
              <ContextMenuItem onSelect={() => revealCard(setView, data.cardId as string)}>
                <ExternalLink size={13} /> Open card
              </ContextMenuItem>
            )}
            {node.type === "url" && typeof data.url === "string" && data.url && (
              <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(data.url as string)}>
                <Copy size={13} /> Copy URL
              </ContextMenuItem>
            )}
            {!isGroup && (
              <ContextMenuItem onSelect={() => void duplicateNode(node)}>
                <Copy size={13} /> Duplicate
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => void deleteElements({ nodes: [{ id: node.id }] })}
              className={CONTEXT_MENU_DANGER}
            >
              <Trash2 size={13} /> {isGroup ? "Delete group" : "Delete node"}
            </ContextMenuItem>
          </>
        );
      })()}
      {menuTarget.kind === "edge" && (
        <ContextMenuItem
          onSelect={() => void deleteElements({ edges: [{ id: menuTarget.edge.id }] })}
          className={CONTEXT_MENU_DANGER}
        >
          <Unlink size={13} /> Delete connection
        </ContextMenuItem>
      )}
    </ContextMenuContent>
    </ContextMenu>
    {/* Outside the trigger: React bubbles portal events to React parents, which would send
        right-clicks in the modal's fields to the canvas menu instead of the text-field menu. */}
      {editTarget && (
        <NodeEditModal
          nodeId={editTarget.nodeId}
          type={editTarget.type}
          data={editTarget.data}
          onSave={handleEditSave}
          onClose={() => setEditTarget(null)}
        />
      )}
    </>
  );
}
