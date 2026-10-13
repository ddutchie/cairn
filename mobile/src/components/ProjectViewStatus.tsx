import { useCallback, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { listCardsWithDueDates, listUnscheduledCards, type CalendarCard } from "@/db/queries";
import { dayKey } from "@/components/calendar/grid";
import { OverviewPanel } from "@/components/overview/OverviewPanel";
import type { OverviewNav } from "@/components/overview/OverviewTab";
import { PressableScale } from "@/components/PressableScale";
import { SegmentedControl } from "@/components/SegmentedControl";
import { calendarStatus } from "@/lib/project-status";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import type { CalendarLayout } from "@/components/CalendarView";

interface CalendarControls {
  layout: CalendarLayout;
  onLayout: (l: CalendarLayout) => void;
  onToday: () => void;
}

/**
 * The status column beside the Board / Calendar when they take the big column
 * (wide windows). The view switcher is pinned above (it must not scroll with the
 * content); below it, reused Overview blocks — Board: needs-attention strip, task
 * flow and open-by-priority; Calendar: today / week / month counts and the attention
 * queue, plus its Today and Month/Week controls (the calendar's own bar is hidden).
 */
export function ProjectViewStatus({
  projectId,
  view,
  switcher,
  nav,
  calendar,
}: {
  projectId: string;
  view: "board" | "calendar";
  switcher: ReactNode;
  nav: OverviewNav;
  calendar?: CalendarControls;
}) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    <View style={styles.root}>
      <View style={styles.switcher}>{switcher}</View>
      {view === "board" ? (
        <OverviewPanel projectId={projectId} show={["kpi", "flow", "priority"]} nav={nav} />
      ) : (
        <OverviewPanel
          projectId={projectId}
          show={["queue"]}
          nav={nav}
          header={<CalendarCounts projectId={projectId} calendar={calendar} styles={styles} />}
        />
      )}
    </View>
  );
}

function CalendarCounts({
  projectId,
  calendar,
  styles,
}: {
  projectId: string;
  calendar?: CalendarControls;
  styles: ReturnType<typeof makeStyles>;
}) {
  const t = useTheme();
  const [dated, setDated] = useState<CalendarCard[]>([]);
  const [unscheduled, setUnscheduled] = useState<CalendarCard[]>([]);
  const load = useCallback(() => {
    setDated(listCardsWithDueDates(projectId));
    setUnscheduled(listUnscheduledCards(projectId));
  }, [projectId]);
  useRefreshOnFocus(load);
  const cal = useMemo(
    () => calendarStatus(dated, unscheduled.filter((c) => !c.is_done).length, dayKey(new Date())),
    [dated, unscheduled],
  );
  const cells: { label: string; value: number; accent: string; caption: string; tone?: string }[] = [
    { label: "Today", value: cal.today, accent: t.accent, caption: cal.today ? "due today" : "nothing due" },
    { label: "This week", value: cal.week, accent: t.info, caption: "open tasks" },
    { label: "This month", value: cal.month, accent: t.success, caption: "open tasks" },
    { label: "Overdue", value: cal.overdue, accent: t.danger, caption: cal.overdue ? "need a new date" : "all caught up", tone: cal.overdue ? t.danger : undefined },
  ];
  return (
    <>
      {calendar ? (
        <View style={styles.controls}>
          <View style={styles.flex}>
            <SegmentedControl
              // Same native control (and sizing notes) as the view switcher above.
              style={{ height: 32 }}
              tintColor={t.accent}
              fontStyle={{ color: t.textSecondary, fontSize: 14, fontWeight: "600" }}
              activeFontStyle={{ color: t.accentFg, fontSize: 14, fontWeight: "600" }}
              values={["Month", "Week"]}
              selectedIndex={calendar.layout === "month" ? 0 : 1}
              onChange={(e) => calendar.onLayout(e.nativeEvent.selectedSegmentIndex === 0 ? "month" : "week")}
            />
          </View>
          <PressableScale style={styles.today} onPress={calendar.onToday} accessibilityLabel="Go to today">
            <Text style={styles.todayText}>Today</Text>
          </PressableScale>
        </View>
      ) : null}
      <View style={styles.strip}>
        {cells.map((c, i) => (
          <View
            key={c.label}
            style={[
              styles.cell,
              i % 2 === 0 && { borderRightWidth: StyleSheet.hairlineWidth },
              i < 2 && { borderBottomWidth: StyleSheet.hairlineWidth },
            ]}
            accessible
            accessibilityLabel={`${c.label}: ${c.value}, ${c.caption}`}
          >
            <View style={[styles.accent, { backgroundColor: c.accent }]} />
            <Text style={styles.cellLabel}>{c.label.toUpperCase()}</Text>
            <Text style={[styles.cellValue, c.tone ? { color: c.tone } : null]}>{c.value}</Text>
            <Text style={styles.cellCaption} numberOfLines={1}>
              {c.caption}
            </Text>
          </View>
        ))}
      </View>
    </>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.background },
    // Pinned above the scrolling blocks; same insets as the other segment bars.
    switcher: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6 },
    flex: { flex: 1 },
    controls: { flexDirection: "row", alignItems: "center", gap: 10 },
    today: { paddingHorizontal: 16, height: 32, justifyContent: "center", borderRadius: 16, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface },
    todayText: { ...typeScale.control, color: t.textPrimary, fontWeight: "600" },
    // Mirrors the Overview's KPI strip (OverviewTab kpiStrip / kpiCell).
    strip: { borderWidth: 1, borderColor: t.border, backgroundColor: t.surface, borderRadius: 12, overflow: "hidden", flexDirection: "row", flexWrap: "wrap" },
    cell: { width: "50%", padding: 12, gap: 2, borderColor: t.border },
    accent: { position: "absolute", top: 0, left: 0, right: 0, height: 3 },
    cellLabel: { fontSize: 10, fontWeight: "600", letterSpacing: 0.5, color: t.textTertiary },
    cellValue: { ...typeScale.heading, color: t.textPrimary, marginTop: 4 },
    cellCaption: { ...typeScale.caption, color: t.textTertiary, fontSize: 11, marginTop: 2 },
  });
}
