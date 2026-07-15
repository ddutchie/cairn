import { StyleSheet } from "react-native";
import { useTheme, withAlpha, type as typeScale, type Theme } from "@/theme";
import { useMemo } from "react";

/**
 * The single StyleSheet shared by CalendarView and all its sub-components,
 * moved verbatim from the original monolithic file. Passed down as a `styles`
 * prop (computed once by the host) so each child re-uses the same instance
 * rather than rebuilding its own — matching the pre-refactor behaviour exactly.
 */
export function makeCalendarStyles(t: Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.background },
    // Toolbar
    toolbar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
      backgroundColor: t.surface,
    },
    navGroup: { flexDirection: "row", alignItems: "center", gap: 8 },
    iconBtn: { padding: 4, borderRadius: 6 },
    todayBtn: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: t.border,
    },
    todayText: { ...typeScale.control, color: t.textSecondary },
    periodLabel: { ...typeScale.title, flex: 1, color: t.textPrimary },
    toggle: {
      flexDirection: "row",
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 8,
      overflow: "hidden",
    },
    toggleBtn: { paddingHorizontal: 12, paddingVertical: 6 },
    toggleText: { ...typeScale.control },
    // Overdue tray
    overdueTray: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
      backgroundColor: withAlpha(t.danger, 0.06),
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    overdueHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
    overdueTitle: { ...typeScale.label, color: t.danger },
    overdueRow: { gap: 8, paddingRight: 12 },
    overdueChipWrap: { width: 150, gap: 2 },
    overdueWas: { fontSize: 10, color: t.textTertiary, paddingHorizontal: 4 },
    // Weekday header
    weekHeader: { flexDirection: "row", backgroundColor: t.surface2 },
    weekday: {
      flex: 1,
      textAlign: "center",
      fontSize: 10,
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: 0.5,
      color: t.textTertiary,
      paddingVertical: 6,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: t.border,
    },
    // Grid
    gridScroll: { flex: 1 },
    grid: { flexDirection: "row", flexWrap: "wrap" },
    cell: {
      width: `${100 / 7}%`,
      minHeight: 76,
      padding: 2,
      gap: 2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
    },
    cellWeek: { minHeight: 200 },
    cellHighlight: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      borderWidth: 1.5,
      borderColor: t.accent,
      backgroundColor: withAlpha(t.accent, 0.1),
    },
    cellHeader: { flexDirection: "row", justifyContent: "flex-start" },
    dayNumWrap: {
      minWidth: 18,
      height: 18,
      paddingHorizontal: 4,
      borderRadius: 9,
      alignItems: "center",
      justifyContent: "center",
    },
    dayNum: { fontSize: 10.5, fontWeight: "700" },
    cellChips: { gap: 2 },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      borderRadius: 4,
      borderWidth: 1,
      paddingHorizontal: 4,
      paddingVertical: 2,
    },
    chipDot: { width: 6, height: 6, borderRadius: 3 },
    chipText: { flex: 1, fontSize: 9.5, lineHeight: 12 },
    // Downward pointer tail under the lifted drag clone — a CSS triangle,
    // centred, in the accent colour, tip aligned to the finger (see liftOffsetY).
    dragTail: {
      alignSelf: "center",
      width: 0,
      height: 0,
      borderLeftWidth: 6,
      borderRightWidth: 6,
      borderTopWidth: 8,
      borderLeftColor: "transparent",
      borderRightColor: "transparent",
      borderTopColor: t.accent,
      marginTop: -1,
    },
    moreText: { fontSize: 9.5, fontWeight: "600", color: t.textTertiary, paddingHorizontal: 4, paddingTop: 1 },
    // Selected-day list (below the grid)
    dayList: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border,
      backgroundColor: t.surface,
      paddingHorizontal: 16,
      paddingTop: 12,
    },
    dayListTitle: { ...typeScale.subtitle, color: t.textPrimary, marginBottom: 4 },
    dayListEmpty: { ...typeScale.caption, color: t.textTertiary, paddingVertical: 12 },
    sheetRow: {
      flexDirection: "row",
      gap: 12,
      paddingVertical: 12,
      alignItems: "center",
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.borderSubtle,
    },
    priorityBar: { width: 3, alignSelf: "stretch", borderRadius: 2 },
    sheetRowBody: { flex: 1, gap: 5 },
    sheetRowTitle: { ...typeScale.control, fontWeight: "500", color: t.textPrimary },
    sheetRowMeta: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
    sheetRowProject: { ...typeScale.micro, fontWeight: "400", color: t.textTertiary, maxWidth: 140 },
    sheetBadge: { ...typeScale.micro, fontWeight: "600" },
    tagChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingVertical: 2,
      paddingHorizontal: 8,
      borderRadius: 10,
      borderWidth: 1,
    },
    tagDot: { width: 6, height: 6, borderRadius: 3 },
    tagText: { ...typeScale.micro, fontWeight: "600", maxWidth: 100 },
    // Unscheduled tray
    tray: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border,
      backgroundColor: t.surface,
      paddingHorizontal: 12,
      paddingBottom: 8,
    },
    trayHighlight: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      borderWidth: 1.5,
      borderColor: t.accent,
      backgroundColor: withAlpha(t.accent, 0.08),
    },
    trayHeader: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 10 },
    trayTitle: { ...typeScale.label, color: t.textSecondary },
    trayCount: { ...typeScale.label, fontWeight: "400", color: t.textTertiary },
    trayEmpty: { ...typeScale.caption, color: t.textTertiary, paddingBottom: 8 },
    // Cap the tray so a large backlog of undated tasks scrolls within a fixed
    // band instead of pushing the calendar grid off-screen.
    trayScroll: { maxHeight: 168 },
    trayChips: { flexDirection: "row", flexWrap: "wrap", paddingBottom: 8 },
    trayGroup: { paddingBottom: 4 },
    trayGroupLabel: { ...typeScale.micro, fontWeight: "700", color: t.textSecondary, textTransform: "uppercase", letterSpacing: 0.4, paddingBottom: 4 },
    trayGroupCount: { fontWeight: "400", color: t.textTertiary },
    // Three chips per row: each wrap is a third of the width, with the gap
    // created by internal padding (mixing container `gap` with 33.33% widths
    // would overflow, so spacing lives inside each cell instead).
    trayChipWrap: { width: "33.33%", paddingRight: 6, paddingBottom: 6, gap: 2 },
    trayProject: { ...typeScale.micro, color: t.textTertiary, paddingHorizontal: 4 },
  });
}

/** Shared style type passed to every calendar sub-component. */
export type CalendarStyles = ReturnType<typeof makeCalendarStyles>;

/** Hook returning the memoised calendar styles for the current theme. */
export function useCalendarStyles(): CalendarStyles {
  const t = useTheme();
  return useMemo(() => makeCalendarStyles(t), [t]);
}
