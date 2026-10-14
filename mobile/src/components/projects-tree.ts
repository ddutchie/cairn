import { useCallback, useMemo } from "react";
import type { SFSymbol } from "sf-symbols-typescript";
import { resolveProjectIconName } from "@cairn/shared/ui/constants";
import type { ProjectSummary } from "@/db/queries";

// The shared (desktop + phone) project icons are Lucide names; the sidebar is
// SwiftUI, so each maps to its closest SF Symbol. Keys mirror ICON_MAP in
// ProjectIcon.tsx. (SF Symbols has no rocket — paperplane is the nearest.)
const SF_FOR_ICON: Record<string, SFSymbol> = {
  Layers: "square.stack.3d.up",
  Folder: "folder",
  BookOpen: "book",
  Briefcase: "briefcase",
  Code2: "chevron.left.forwardslash.chevron.right",
  Cpu: "cpu",
  Globe: "globe",
  Home: "house",
  Inbox: "tray",
  Lightbulb: "lightbulb",
  Map: "map",
  Mountain: "mountain.2",
  Pencil: "pencil",
  Rocket: "paperplane",
  Star: "star",
  Target: "target",
  TreePine: "tree",
  Waves: "water.waves",
  Zap: "bolt",
};

/**
 * The projects list shown in the split-view sidebar column
 * (`ProjectsTreeSidebar`): a flat list of projects. Switching between a
 * project's views (Overview / Notes / Board / Calendar) is the segmented control
 * at the top of the project column, not rows here — so the same control works at
 * every width and the sidebar only has one job: choosing the project.
 */
export interface ProjectNode {
  id: string;
  title: string;
  /** "126 notes · 69 tasks". */
  subtitle: string;
  /** The project's own icon, as an SF Symbol. */
  icon: SFSymbol;
}

export interface ProjectsList {
  nodes: ProjectNode[];
  /** The selected project, or null (nothing chosen yet, e.g. the collapsed root). */
  selectedId: string | null;
  select: (projectId: string) => void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function useProjectsList({
  projects,
  projectId,
  onSelect,
}: {
  projects: ProjectSummary[];
  projectId: string | null;
  onSelect: (projectId: string) => void;
}): ProjectsList {
  const nodes = useMemo(
    () =>
      projects.map<ProjectNode>((p) => ({
        id: p.id,
        title: p.name,
        subtitle: `${plural(p.noteCount, "note", "notes")} · ${plural(p.cardCount, "task", "tasks")}`,
        icon: SF_FOR_ICON[resolveProjectIconName(p.icon)] ?? "folder",
      })),
    [projects],
  );
  const select = useCallback((id: string) => onSelect(id), [onSelect]);
  return { nodes, selectedId: projectId, select };
}
