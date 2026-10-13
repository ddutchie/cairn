import { SegmentedControl } from "@/components/SegmentedControl";
import { useTheme } from "@/theme";

export type ProjectViewKind = "overview" | "notes" | "board" | "calendar";

// Segment order = the control's selectedIndex.
const VIEWS: ProjectViewKind[] = ["overview", "notes", "board", "calendar"];

/**
 * Overview | Notes | Board | Calendar, at the top of a project's column in the
 * Projects split view. The one place to change a project's view at every width
 * (the sidebar only chooses the project), so it never takes a trip back to the list.
 */
export function ProjectViewSwitcher({
  view,
  noteCount,
  cardCount,
  onSelect,
}: {
  view: ProjectViewKind;
  noteCount: number;
  cardCount: number;
  onSelect: (view: ProjectViewKind) => void;
}) {
  const t = useTheme();
  return (
    <SegmentedControl
      // Same sizing notes as ProjectScreen's own control: fixed height only (a
      // flex:1 basis collapses the native view), no backgroundColor (the iOS
      // 26/27 Liquid Glass track can't be stripped).
      style={{ height: 36 }}
      tintColor={t.accent}
      fontStyle={{ color: t.textSecondary, fontSize: 14, fontWeight: "600" }}
      activeFontStyle={{ color: t.accentFg, fontSize: 14, fontWeight: "600" }}
      values={["Overview", `Notes ${noteCount}`, `Board ${cardCount}`, "Calendar"]}
      selectedIndex={Math.max(0, VIEWS.indexOf(view))}
      onChange={(e) => onSelect(VIEWS[e.nativeEvent.selectedSegmentIndex] ?? "overview")}
    />
  );
}
