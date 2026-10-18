import { useMemo, useState } from "react";
import type { GraphNodeType, KnowledgeGraph } from "@/db/types";
import type { LabelMode } from "@cairn/shared/ui/graph";
import { ALL_NODE_TYPES, filterGraph } from "./filter";

export type GraphMode = "force" | "radial";

interface Options {
  mode?: GraphMode;
  onModeChange?: (mode: GraphMode) => void;
  labelMode?: LabelMode;
  onLabelModeChange?: (mode: LabelMode) => void;
}

/**
 * View state shared by every graph renderer: layout/label mode (controlled by
 * the native toolbar when the parent passes them, internal otherwise), hulls,
 * search, node-type chips, and the filtered graph those produce.
 */
export function useGraphControls(graph: KnowledgeGraph, o: Options) {
  const [modeInternal, setModeInternal] = useState<GraphMode>("force");
  const mode = o.mode ?? modeInternal;
  const setMode = (m: GraphMode) => (o.onModeChange ? o.onModeChange(m) : setModeInternal(m));

  const [labelInternal, setLabelInternal] = useState<LabelMode>("smart");
  const labelMode = o.labelMode ?? labelInternal;
  const setLabelMode = (m: LabelMode) => (o.onLabelModeChange ? o.onLabelModeChange(m) : setLabelInternal(m));

  const [activeTypes, setActiveTypes] = useState<Set<GraphNodeType>>(() => new Set(ALL_NODE_TYPES));
  const [showHulls, setShowHulls] = useState(true);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => filterGraph(graph, activeTypes, search), [graph, activeTypes, search]);

  const toggleType = (type: GraphNodeType) =>
    setActiveTypes((cur) => {
      const next = new Set(cur);
      if (next.has(type)) {
        if (next.size === 1) return cur; // keep at least one active
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });

  return {
    mode, setMode, labelMode, setLabelMode, activeTypes, toggleType,
    showHulls, toggleHulls: () => setShowHulls((v) => !v),
    search, setSearch, filtered,
    showModeToggle: !o.onModeChange,
    showLabelPill: !o.onLabelModeChange,
  };
}
