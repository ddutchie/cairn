import { useCallback, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { listCardsWithDueDates, listUnscheduledCards, type CalendarCard } from "@/db/queries";
import { dayKey } from "@/components/calendar/grid";
import { OverviewPanel } from "@/components/overview/OverviewPanel";
import type { OverviewNav } from "@/components/overview/OverviewTab";
import { PressableScale } from "@/components/PressableScale";
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
  return (
    <>
      {calendar ? (
        <View style={styles.row}>
          <PressableScale style={[styles.ctl, styles.flex]} onPress={calendar.onToday} accessibilityLabel="Go to today">
            <Text style={styles.ctlText}>Today</Text>
          </PressableScale>
          {(["month", "week"] as const).map((l) => (
            <PressableScale
              key={l}
              style={[styles.ctl, styles.flex, calendar.layout === l && { backgroundColor: t.accent, borderColor: t.accent }]}
              onPress={() => calendar.onLayout(l)}
              accessibilityLabel={`${l} view`}
              accessibilityState={{ selected: calendar.layout === l }}
            >
              <Text style={[styles.ctlText, calendar.layout === l && { color: t.accentFg }]}>{l === "month" ? "Month" : "Week"}</Text>
            </PressableScale>
          ))}
        </View>
      ) : null}
      <Tile label="Today" value={cal.today} big styles={styles} />
      <View style={styles.row}>
        <Tile label="This week" value={cal.week} styles={styles} />
        <Tile label="This month" value={cal.month} styles={styles} />
      </View>
      <View style={styles.row}>
        <Tile label="Overdue" value={cal.overdue} tone={cal.overdue ? t.danger : undefined} styles={styles} />
        <Tile label="Unscheduled" value={cal.unscheduled} styles={styles} />
      </View>
    </>
  );
}

function Tile({
  label,
  value,
  tone,
  big,
  styles,
}: {
  label: string;
  value: number;
  tone?: string;
  big?: boolean;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={[styles.tile, styles.flex]} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={styles.tileLabel}>{label.toUpperCase()}</Text>
      <Text style={[big ? styles.valueBig : styles.value, tone ? { color: tone } : null]}>{value}</Text>
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.background },
    // Pinned above the scrolling blocks; same insets as the other segment bars.
    switcher: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6 },
    row: { flexDirection: "row", gap: 10 },
    flex: { flex: 1 },
    tile: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 14, padding: 14, gap: 6 },
    tileLabel: { ...typeScale.overline, color: t.textTertiary },
    value: { fontSize: 26, fontWeight: "700", color: t.textPrimary },
    valueBig: { fontSize: 40, fontWeight: "700", color: t.textPrimary },
    ctl: { alignItems: "center", paddingVertical: 9, borderRadius: 12, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface },
    ctlText: { ...typeScale.control, color: t.textPrimary, fontWeight: "600" },
  });
}
