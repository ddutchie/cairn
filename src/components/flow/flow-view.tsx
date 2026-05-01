"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  Panel,
} from "@xyflow/react";

import { Lightbulb, FileText, CheckSquare, Link2, Sparkles, Plus } from "lucide-react";
import { useCairnStore } from "@/store";
import type { IdeaNodeType, ResolvedIdeaFlow } from "@/types";
import { IdeaNode }      from "./nodes/IdeaNode";
import { NoteRefNode }   from "./nodes/NoteRefNode";
import { TaskRefNode }   from "./nodes/TaskRefNode";

import { UrlNode }       from "./nodes/UrlNode";
import { AiSummaryNode } from "./nodes/AiSummaryNode";
import { FlowEdge }      from "./edges/FlowEdge";
import { NodeEditModal } from "./NodeEditModal";
import { cn } from "@/lib/utils";

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
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function flowNodeToRF(n: ResolvedIdeaFlow["nodes"][number]): Node {
  return {
    id: n.id,
    type: n.type,
    position: { x: n.x, y: n.y },
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
  }
}

const ADD_NODE_MENU: Array<{ type: IdeaNodeType; label: string; icon: React.ElementType }> = [
  { type: "idea",       label: "Idea",       icon: Lightbulb   },
  { type: "note_ref",   label: "Note",        icon: FileText    },
  { type: "task_ref",   label: "Task",        icon: CheckSquare },
  { type: "url",        label: "URL",         icon: Link2       },
  { type: "ai_summary", label: "AI Summary",  icon: Sparkles    },
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
  const { activeProjectId } = useCairnStore();
  const { fitView, screenToFlowPosition } = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [loading, setLoading]       = useState(true);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);

  // Context menu state — screen coords for positioning, flow coords for node placement
  const [contextMenu, setContextMenu] = useState<{ screenX: number; screenY: number; flowX: number; flowY: number } | null>(null);

  const [editTarget, setEditTarget] = useState<{
    nodeId: string; type: IdeaNodeType; data: Record<string, unknown>;
  } | null>(null);

  const nodeCountRef = useRef(0);
  const initialLoadDone = useRef(false);

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

  // ── Load ──────────────────────────────────────────────────────

  const loadFlow = useCallback(async (isInitial = false) => {
    if (!activeProjectId || !window.electron) return;
    if (isInitial) setLoading(true);
    try {
      const flow = await window.electron.flow.get(activeProjectId) as ResolvedIdeaFlow;
      nodeCountRef.current = flow.nodes.length;
      const incoming = flow.nodes.map(flowNodeToRF);

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

  useEffect(() => { loadFlow(true); }, [loadFlow]);

  // Re-hydrate on external (MCP/AI) DB writes — but NOT on our own writes.
  useEffect(() => {
    if (!window.electron) return;
    const unsub = window.electron.onDbChanged(() => {
      if (!suppressReloadRef.current) loadFlow(false);
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
    (params: Connection) => {
      setEdges((eds) => addEdge({ ...params, type: "flow" }, eds));
      suppressReload();
      window.electron?.flow.edge.create({
        projectId: activeProjectId,
        sourceNodeId: params.source,
        targetNodeId: params.target,
      });
    },
    [setEdges, activeProjectId],
  );

  // ── Node drag stop — persist position ────────────────────────

  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    suppressReload();
    window.electron?.flow.node.update(node.id, { x: node.position.x, y: node.position.y });
  }, []);

  // ── Deletions — persist to DB ─────────────────────────────────

  const onEdgesDelete = useCallback((deleted: Edge[]) => {
    suppressReload();
    deleted.forEach((e) => window.electron?.flow.edge.delete(e.id));
  }, []);

  const onNodesDelete = useCallback((deleted: Node[]) => {
    suppressReload();
    deleted.forEach((n) => window.electron?.flow.node.delete(n.id));
  }, []);

  // ── Double-click node → edit ──────────────────────────────────

  const onNodeDoubleClick: NodeMouseHandler = useCallback((_e, node) => {
    if (node.type === "ai_summary") return;
    setEditTarget({ nodeId: node.id, type: node.type as IdeaNodeType, data: node.data as Record<string, unknown> });
  }, []);

  // ── Context menu ──────────────────────────────────────────────

  const onPaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    setContextMenu({ screenX: e.clientX, screenY: e.clientY, flowX: flowPos.x, flowY: flowPos.y });
  }, [screenToFlowPosition]);

  // ── Add node ──────────────────────────────────────────────────

  async function addNode(type: IdeaNodeType, x = 200, y = 200) {
    if (!activeProjectId || !window.electron) return;
    const data = defaultData(type);
    suppressReload();
    const created = await window.electron.flow.node.create({ projectId: activeProjectId, type, x, y, data }) as { id: string };
    nodeCountRef.current += 1;
    setNodes((ns) => [...ns, { id: created.id, type, position: { x, y }, data }]);
    setEditTarget({ nodeId: created.id, type, data: data as Record<string, unknown> });
    setShowAddMenu(false);
  }

  // ── Save from edit modal ──────────────────────────────────────

  const handleEditSave = useCallback((nodeId: string, data: Record<string, unknown>) => {
    setNodes((ns) => ns.map((n) => n.id === nodeId ? { ...n, data } : n));
    suppressReload();
    window.electron?.flow.node.update(nodeId, { data });
    // For ref nodes, reload after save to get resolved title/snippet
    const node = nodes.find((n) => n.id === nodeId);
    if (node?.type === "note_ref" || node?.type === "task_ref") {
      suppressReloadRef.current = false;
      loadFlow(false);
    }
  }, [setNodes, nodes, loadFlow]);

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
        if ((e.target as HTMLElement).classList.contains("react-flow__pane")) {
          const n = nodeCountRef.current;
          addNode("idea", 80 + (n % 5) * 240, 80 + Math.floor(n / 5) * 180);
        }
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={onNodeDragStop}
        onEdgesDelete={onEdgesDelete}
        onNodesDelete={onNodesDelete}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={() => { setShowAddMenu(false); setContextMenu(null); }}
        onPaneContextMenu={onPaneContextMenu}

        connectionLineType={ConnectionLineType.Bezier}
        connectionLineStyle={{ stroke: "#6366f1", strokeWidth: 1.5, opacity: 0.7 }}
        zoomOnDoubleClick={false}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
        <Controls style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10 }} />
        <MiniMap
          style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10 }}
          nodeColor="var(--surface-2)"
          maskColor="var(--background)"
        />

        <Panel position="top-right">
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
                {ADD_NODE_MENU.map(({ type, label, icon: Icon }) => (
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
            <p className="px-3 pt-1 pb-1.5 text-[10px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
              Add node
            </p>
            {ADD_NODE_MENU.map(({ type, label, icon: Icon }) => (
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
