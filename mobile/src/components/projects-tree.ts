import { useCallback, useMemo } from "react";
import type { SFSymbol } from "sf-symbols-typescript";
import type { ProjectSummary } from "@/db/queries";

/**
 * The projects tree — projects that expand to their views, like Mail's accounts
 * and mailboxes. One model for every wide layout; only the renderer differs:
 * the iPad's system tab sidebar (modules/tab-sidebar) or the in-app panel
 * (ProjectsTreePanel: the Duo, and the iPad when the system sidebar can't be
 * used).
 */
export interface TreeNode {
  id: string;
  title: string;
  icon: SFSymbol;
  /** A count shown beside the row (notes, tasks). */
  badge?: string;
  children?: TreeNode[];
}

export interface TreeView {
  id: string;
  title: string;
  icon: SFSymbol;
}

export interface ProjectsTree {
  nodes: TreeNode[];
  /** Ids of the selected row: [projectId, view]. */
  selectedPath: string[];
  /** Selects a row by its path: [projectId] or [projectId, view]. */
  select: (path: string[]) => void;
}

export function useProjectsTree({
  projects,
  views,
  projectId,
  view,
  onSelect,
}: {
  projects: ProjectSummary[];
  views: TreeView[];
  projectId: string | null;
  view: string;
  onSelect: (projectId: string, view?: string) => void;
}): ProjectsTree {
  const nodes = useMemo(
    () =>
      projects.map<TreeNode>((p) => ({
        id: p.id,
        title: p.name,
        icon: "folder",
        children: views.map((v) => {
          const count = v.id === "notes" ? p.noteCount : v.id === "board" ? p.cardCount : 0;
          return { id: v.id, title: v.title, icon: v.icon, ...(count ? { badge: String(count) } : {}) };
        }),
      })),
    [projects, views],
  );
  const selectedPath = useMemo(() => (projectId ? [projectId, view] : []), [projectId, view]);
  const select = useCallback(([id, next]: string[]) => onSelect(id, next), [onSelect]);
  return { nodes, selectedPath, select };
}
