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

import { Lightbulb, FileText, CheckSquare, Link2, Sparkles, Plus, Layers, LayoutDashboard } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { IdeaNodeType, ResolvedIdeaFlow } from "@/types";
import { historyManager, flowHandlers, ownWriteGuard } from "@/lib/history";
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
import { IdeaNode }      from "./nodes/IdeaNode";
import { NoteRefNode }   from "./nodes/NoteRefNode";
import { TaskRefNode }   from "./nodes/TaskRefNode";
import { GroupNode }     from "./nodes/GroupNode";
import { UrlNode }       from "./nodes/UrlNode";
import { AiSummaryNode } from "./nodes/AiSummaryNode";
import { FlowEdge }      from "./edges/FlowEdge";
import { NodeEditModal } from "./NodeEditModal";

import { applyDagreLayout } from "@/lib/flow-layout";

// ── Group membership helpers ──────────────────────────────────────────────────

/**
 * Given the current React Flow nodes, compute which non-group nodes should
 * belong to which group based on whether the node's center falls inside the
 * group's bounding box. Returns a list of assignments to apply.
 *
 * Groups use absolute position + style width/height.
 * Non-group nodes with an existing parentId have relative positions — we
 * convert to absolute using their current parent's position first.
 */
function computeGroupAssignments(nodes: Node[]): Array<{
  nodeId: string;
  parentId: string | null; // null = remove from group
  x: number;              // new x to store (relative if parentId set, absolute if not)
  y: number;
}> {
  const groups = nodes.filter((n) => n.type === "group");

  // Build absolute position map for all nodes
  const absPos = new Map<string, { x: number; y: number }>();
  // First pass: root nodes (no parentId)
  for (const n of nodes) {
    if (!n.parentId) absPos.set(n.id, { x: n.position.x, y: n.position.y });
  }
  // Second pass: children — add parent's absolute position
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

    // Find the smallest group whose bounds contain this node's center
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

    if (newParentId === currentParentId) continue; // no change

    if (newParentId) {
      // Convert absolute → relative to new group
      const gAbs = absPos.get(newParentId)!;
      changes.push({ nodeId: node.id, parentId: newParentId, x: abs.x - gAbs.x, y: abs.y - gAbs.y });
    } else {
      // Leaving group — keep absolute position
      changes.push({ nodeId: node.id, parentId: null, x: abs.x, y: abs.y });
    }
  }

  return changes;
}

// ── Type registries — defined outside component to prevent remounts ───────────

const EDGE_TYPES = {
  flow: FlowEdge,
};

const DEFAULT_EDGE_OPTIONS: Partial<Edge> = {
  type: "flow",
};

const NODE_TYPES = {
  idea:       IdeaNode,
  note_ref:   NoteRefNode,
  task_ref:   TaskRefNode,
  url:        UrlNode,
  ai_summary: AiSummaryNode,
  group:      GroupNode,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function flowNodeToRF(n: ResolvedIdeaFlow["nodes"][number]): Node {
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

function flowEdgeToRF(e: ResolvedIdeaFlow["edges"][number]): Edge {
  return {
    id: e.id,
    source: e.sourceNodeId,
    target: e.targetNodeId,
    label: e.label ?? undefined,
    type: "flow",
  };
}

function defaultData(type: IdeaNodeType) {
  switch (type) {
    case "idea":       return { title: "New idea", body: "" };
    case "note_ref":   return { noteId: "" };
    case "task_ref":   return { cardId: "" };
    case "url":        return { url: "", title: "", description: "" };
    case "ai_summary": return { content: "" };
    case "group":      return { label: "Group", color: "accent" };
  }
}

const ADD_NODE_MENU: Array<{ type: IdeaNodeType; label: string; icon: React.ElementType }> = [
  { type: "idea",       label: "Idea",        icon: Lightbulb   },
  { type: "note_ref",   label: "Note",         icon: FileText    },
  { type: "task_ref",   label: "Task",         icon: CheckSquare },
  { type: "url",        label: "URL",          icon: Link2       },
  { type: "ai_summary", label: "AI Summary",   icon: Sparkles    },
  { type: "group",      label: "Group",        icon: Layers      },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function IdeaFlowView() {
  return (
    <ReactFlowProvider>
      <IdeaFlowCanvas />
    </ReactFlowProvider>
  );
}

function IdeaFlowCanvas() {
  const { activeProjectId, columns, activeWorkspaceId, aiConfig } = useCairnStore(useShallow((s) => ({
    activeProjectId:   s.activeProjectId,
    columns:           s.columns,
    activeWorkspaceId: s.activeWorkspaceId,
    aiConfig:          s.aiConfig,
  })));
  const aiEnabled = aiConfig.aiEnabled ?? true;
  const addNodeMenu = ADD_NODE_MENU.filter((n) => n.type !== "ai_summary" || aiEnabled);
  const { fitView, screenToFlowPosition, getInternalNode } = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [loading, setLoading]       = useState(true);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);

  // Detect touch device for mobile-specific interactions
  const isTouchDevice = typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;

  // Long-press state for mobile add-node and edit-node
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressCancelledRef = useRef(false);

  // Context menu state — screen coords for positioning, flow coords for node placement
  const [contextMenu, setContextMenu] = useState<{ screenX: number; screenY: number; flowX: number; flowY: number } | null>(null);

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
  // Timestamp of the last user-initiated DB write. Used to distinguish
  // our own db:changed events from genuinely external (MCP/AI) ones.
  const lastOwnWriteAtRef = useRef(0);

  function suppressReload(ms = 1500) {
    suppressReloadRef.current = true;
    lastOwnWriteAtRef.current = Date.now();
    ownWriteGuard.touch(); // tell page.tsx's db:changed not to clear history
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
    if (!activeProjectId || !window.electron) return;
    if (isInitial) setLoading(true);
    try {
      const flow = await window.electron.flow.get(activeProjectId) as ResolvedIdeaFlow;
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

  // Re-hydrate on external (MCP/AI) DB writes — but NOT on our own writes.
  // External writes also clear the undo stack since history is now stale.
  useEffect(() => {
    if (!window.electron) return;
    const unsub = window.electron.onDbChanged(() => {
      const isOwnWrite = (Date.now() - lastOwnWriteAtRef.current) < 3000;
      if (!suppressReloadRef.current) {
        loadFlow(false);
      }
      if (!isOwnWrite) {
        historyManager.clear();
      }
    });
    return () => { unsub(); };
  }, [loadFlow]);

  // Close add-menu on outside click
  useEffect(() => {
    if (!showAddMenu) return;
    function handleClick(e: MouseEvent) {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Element)) {
        setShowAddMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showAddMenu]);

  // ── Connect ───────────────────────────────────────────────────

  const onConnect = useCallback(
    async (params: Connection) => {
      suppressReload();
      const created = await window.electron?.flow.edge.create({
        projectId: activeProjectId,
        sourceNodeId: params.source,
        targetNodeId: params.target,
      }) as { id: string } | undefined;
      const edgeId = created?.id ?? `${params.source}-${params.target}`;
      const rfEdge: Edge = { id: edgeId, source: params.source!, target: params.target!, type: "flow" };
      setEdges((eds) => addEdge({ ...rfEdge }, eds));
      historyManager.push(makeAddEdgeCmd(rfEdge, activeProjectId ?? ""));
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
      window.electron?.flow.node.update(change.nodeId, {
        x: change.x,
        y: change.y,
        parentId: change.parentId ?? null,
      });
    }
    // Persist the forced node (dragged node leaving a group with no membership change detected)
    if (forcedNode && !changedByCompute.has(forcedNode.id)) {
      window.electron?.flow.node.update(forcedNode.id, {
        x: forcedNode.position.x,
        y: forcedNode.position.y,
        parentId: forcedNode.parentId ?? null,
      });
    }
    // Persist position for nodes that didn't change membership but were in currentNodes
    // (the dragged node when it stays in the same group or stays ungrouped)
    const changedIds = new Set(changes.map((c) => c.nodeId));
    for (const n of currentNodes) {
      if (!changedIds.has(n.id) && n.id !== forcedNodeId && n.type !== "group") {
        const orig = nodesRef.current.find((o) => o.id === n.id);
        if (orig && (orig.position.x !== n.position.x || orig.position.y !== n.position.y)) {
          window.electron?.flow.node.update(n.id, { x: n.position.x, y: n.position.y });
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
          window.electron?.flow.node.update(id, { width: dimensions.width, height: dimensions.height });
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
      window.electron?.flow.edge.delete(e.id);
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
        window.electron?.flow.node.delete(child.id);
      }
      window.electron?.flow.node.delete(group.id);
      historyManager.push(makeDeleteGroupCmd(group, children, activeProjectId ?? ""));
    }

    // Non-group nodes not parented to a deleted group get individual commands.
    const deletedGroupIds = new Set(deletedGroups.map((g) => g.id));
    for (const n of deletedNonGroups) {
      if (deletedGroupIds.has(n.parentId ?? "")) continue; // handled by group cmd
      window.electron?.flow.node.delete(n.id);
      historyManager.push(makeDeleteNodeCmd(n, activeProjectId ?? ""));
    }
  }, [activeProjectId]);

  // ── Double-click node → edit ──────────────────────────────────

  const onNodeDoubleClick: NodeMouseHandler = useCallback((_e, node) => {
    // ai_summary nodes are generator-only — no edit modal
    if (node.type === "ai_summary") return;
    setEditTarget({ nodeId: node.id, type: node.type as IdeaNodeType, data: node.data as Record<string, unknown> });
  }, []);

  // ── Context menu ──────────────────────────────────────────────

  const onPaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    setContextMenu({ screenX: e.clientX, screenY: e.clientY, flowX: flowPos.x, flowY: flowPos.y });
  }, [screenToFlowPosition]);

  // ── Long-press handlers (mobile) ──────────────────────────────

  /** Pane long-press → show add-node context menu at touch position */
  const onPaneTouchStart = useCallback((e: React.TouchEvent) => {
    if (!isTouchDevice) return;
    longPressCancelledRef.current = false;
    const touch = e.touches[0];
    const startX = touch.clientX;
    const startY = touch.clientY;

    longPressTimerRef.current = setTimeout(() => {
      if (longPressCancelledRef.current) return;
      const flowPos = screenToFlowPosition({ x: startX, y: startY });
      setContextMenu({ screenX: startX, screenY: startY, flowX: flowPos.x, flowY: flowPos.y });
    }, 350);
  }, [isTouchDevice, screenToFlowPosition]);

  const onPaneTouchEnd = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const onPaneTouchMove = useCallback(() => {
    longPressCancelledRef.current = true;
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  // Clear long-press timer on unmount
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    };
  }, []);

  // ── Add node ──────────────────────────────────────────────────

  async function addNode(type: IdeaNodeType, x = 200, y = 200) {
    if (!activeProjectId || !window.electron) return;
    const data = defaultData(type);
    // Group nodes get a default size and render behind all other nodes
    const isGroup = type === "group";
    const width  = isGroup ? 320 : undefined;
    const height = isGroup ? 200 : undefined;
    suppressReload();
    const created = await window.electron.flow.node.create({ projectId: activeProjectId, type, x, y, data, width, height }) as { id: string };
    nodeCountRef.current += 1;
    const rfNode: Node = {
      id: created.id,
      type,
      position: { x, y },
      data,
      ...(isGroup ? { style: { width, height }, zIndex: -1 } : {}),
    };
    setNodes((ns) => [...ns, rfNode]);
    // ai_summary and group nodes need no edit modal on creation
    if (type !== "ai_summary" && type !== "group") {
      setEditTarget({ nodeId: created.id, type, data: data as Record<string, unknown> });
    }
    setShowAddMenu(false);
    historyManager.push(makeAddNodeCmd(rfNode, activeProjectId));
  }

  // ── Save from edit modal ──────────────────────────────────────

  const handleEditSave = useCallback((nodeId: string, data: Record<string, unknown>) => {
    const node = nodes.find((n) => n.id === nodeId);
    const prevData = (node?.data ?? {}) as Record<string, unknown>;
    setNodes((ns) => ns.map((n) => n.id === nodeId ? { ...n, data } : n));
    suppressReload();
    window.electron?.flow.node.update(nodeId, { data });
    historyManager.push(makeUpdateNodeCmd(nodeId, prevData, data));
    // For ref nodes, reload after save to get resolved title/snippet
    if (node?.type === "note_ref" || node?.type === "task_ref") {
      suppressReloadRef.current = false;
      loadFlow(false);
    }
  }, [setNodes, nodes, loadFlow]);

  // ── Auto-layout ───────────────────────────────────────────────

  const handleAutoLayout = useCallback(async () => {
    if (!activeProjectId || !window.electron) return;
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
    await Promise.all(
      laidOut.map((n) => {
        const isGroup = n.type === "group";
        return window.electron?.flow.node.update(n.id, {
          x: n.position.x,
          y: n.position.y,
          ...(isGroup ? {
            width:  (n.style?.width  as number) ?? undefined,
            height: (n.style?.height as number) ?? undefined,
          } : {}),
        });
      })
    );
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

    // Create a new task card
    const created = await window.electron.card.create({
      projectId: activeProjectId,
      workspaceId: activeWorkspaceId,
      columnId: targetCol.id,
      title,
      description: body,
      priority: "medium",
    }) as { id: string };

    // Snapshot edges connected to the old node before deleting it
    const connectedEdges = edges.filter((e) => e.source === nodeId || e.target === nodeId);

    // Delete the idea node (cascades its DB edges)
    const pos = node.position;
    await window.electron.flow.node.delete(nodeId);

    // Recreate as task_ref at the same position
    const newNode = await window.electron.flow.node.create({
      projectId: activeProjectId,
      type: "task_ref",
      x: pos.x,
      y: pos.y,
      data: { cardId: created.id },
    }) as { id: string };

    // Re-create the edges that were deleted with the old node
    for (const e of connectedEdges) {
      const src = e.source === nodeId ? newNode.id : e.source;
      const tgt = e.target === nodeId ? newNode.id : e.target;
      await window.electron.flow.edge.create({ projectId: activeProjectId, sourceNodeId: src, targetNodeId: tgt, label: e.label as string | undefined });
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
  }, [nodes, edges, setNodes, setEdges, activeProjectId, activeWorkspaceId, columns]);

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
    <div
      className="flex flex-1 min-h-0"
      style={{ background: "var(--background)" }}
      onDoubleClick={(e) => {
        // Desktop: double-click on the pane to add an idea node
        if ((e.target as HTMLElement).classList.contains("react-flow__pane")) {
          const n = nodeCountRef.current;
          addNode("idea", 80 + (n % 5) * 240, 80 + Math.floor(n / 5) * 180);
        }
      }}
      onTouchStart={onPaneTouchStart}
      onTouchEnd={onPaneTouchEnd}
      onTouchMove={onPaneTouchMove}
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
          if (node.type === "ai_summary") return;
          setEditTarget({ nodeId: node.id, type: node.type as IdeaNodeType, data: node.data as Record<string, unknown> });
        } : undefined}
        onPaneClick={() => { setShowAddMenu(false); setContextMenu(null); }}
        onPaneContextMenu={onPaneContextMenu}

        connectionLineType={ConnectionLineType.Bezier}
        connectionLineStyle={{ stroke: "#6366f1", strokeWidth: 1.5, opacity: 0.7 }}
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

        <Panel position="top-right">
          <div className="flex items-center gap-2">
            <button
              onClick={handleAutoLayout}
              title="Auto-arrange nodes"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium shadow-sm bg-[var(--surface)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-hover)] transition-colors"
            >
              <LayoutDashboard size={13} />
              Arrange
            </button>
          <div className="relative" ref={addMenuRef}>
            <button
              onClick={() => setShowAddMenu((v) => !v)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium shadow-sm bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
            >
              <Plus size={13} />
              Add node
            </button>

            {showAddMenu && (
              <div className="absolute right-0 top-9 z-50 bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-xl py-1 min-w-[160px]">
                {addNodeMenu.map(({ type, label, icon: Icon }) => (
                  <button
                    key={type}
                    onClick={() => addNode(type, 120 + Math.random() * 300, 120 + Math.random() * 200)}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    <Icon size={12} className="text-[var(--text-tertiary)]" />
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          </div>
        </Panel>
      </ReactFlow>

      {editTarget && (
        <NodeEditModal
          nodeId={editTarget.nodeId}
          type={editTarget.type}
          data={editTarget.data}
          onSave={handleEditSave}
          onClose={() => setEditTarget(null)}
        />
      )}

      {contextMenu && (
        <div
          style={{ position: "fixed", top: contextMenu.screenY, left: contextMenu.screenX, zIndex: 50 }}
          onMouseLeave={() => setContextMenu(null)}
        >
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-xl py-1 min-w-[160px]">
            <p className="px-3 pt-1 pb-1.5 text-[0.714rem] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
              Add node
            </p>
            {addNodeMenu.map(({ type, label, icon: Icon }) => (
              <button
                key={type}
                onClick={() => {
                  addNode(type, contextMenu.flowX, contextMenu.flowY);
                  setContextMenu(null);
                }}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors"
              >
                <Icon size={12} className="text-[var(--text-tertiary)]" />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
