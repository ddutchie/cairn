import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { listCards, listCardsWithDueDates, listColumns, listUnscheduledCards, type CalendarCard, type CardRow, type ColumnRow } from "@/db/queries";
import { dayKey } from "@/components/calendar/grid";
import { boardStatus, calendarStatus } from "@/lib/project-status";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/**
 * The small status panel beside the Board / Calendar when they take the big column
 * (wide windows): a glance at the project's tasks — Board: open / done and how they
 * spread over the columns; Calendar: today, this week, this month, overdue.
 * The owner re-keys it when a task changes elsewhere on screen so the numbers follow.
 */
export function ProjectViewStatus({
  projectId,
  view,
  switcher,
}: {
  projectId: string;
  view: "board" | "calendar";
  switcher: ReactNode;
}) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [columns, setColumns] = useState<ColumnRow[]>([]);
  const [cards, setCards] = useState<CardRow[]>([]);
  const [dated, setDated] = useState<CalendarCard[]>([]);
  const [unscheduled, setUnscheduled] = useState<CalendarCard[]>([]);
  const load = useCallback(() => {
    setColumns(listColumns(projectId));
    setCards(listCards(projectId));
    setDated(listCardsWithDueDates(projectId));
    setUnscheduled(listUnscheduledCards(projectId));
  }, [projectId]);
  useRefreshOnFocus(load);

  const todayKey = dayKey(new Date());
  const board = useMemo(() => boardStatus(columns, cards, dated, todayKey), [columns, cards, dated, todayKey]);
  const cal = useMemo(
    () => calendarStatus(dated, unscheduled.filter((c) => !c.is_done).length, todayKey),
    [dated, unscheduled, todayKey],
  );
  const maxCount = Math.max(1, ...board.perColumn.map((c) => c.count));

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="never">
      <View style={styles.switcher}>{switcher}</View>
      {view === "board" ? (
        <>
          <Tile label="Open" value={board.open} detail={board.done ? `${board.done} done` : undefined} big styles={styles} />
          <View style={styles.row}>
            <Tile label="Overdue" value={board.overdue} tone={board.overdue ? t.danger : undefined} styles={styles} />
            <Tile label="Due today" value={board.dueToday} tone={board.dueToday ? t.warning : undefined} styles={styles} />
          </View>
          <Tile label="High / urgent" value={board.important} tone={board.important ? t.warning : undefined} styles={styles} />
          <Text style={styles.heading}>BY COLUMN</Text>
          <View style={styles.card}>
            {board.perColumn.map((c) => (
              <View key={c.id} style={styles.colRow}>
                <View style={styles.colHead}>
                  <Text style={styles.colName} numberOfLines={1}>
                    {c.name}
                  </Text>
                  <Text style={styles.colCount}>{c.count}</Text>
                </View>
                <View style={styles.track}>
                  <View style={[styles.fill, { width: `${(c.count / maxCount) * 100}%`, backgroundColor: c.done ? t.success : t.accent }]} />
                </View>
              </View>
            ))}
          </View>
        </>
      ) : (
        <>
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
      )}
    </ScrollView>
  );
}

function Tile({
  label,
  value,
  detail,
  tone,
  big,
  styles,
}: {
  label: string;
  value: number;
  detail?: string;
  tone?: string;
  big?: boolean;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={[styles.tile, styles.flex]} accessible accessibilityLabel={`${label}: ${value}${detail ? `, ${detail}` : ""}`}>
      <Text style={styles.tileLabel}>{label.toUpperCase()}</Text>
      <View style={styles.valueRow}>
        <Text style={[big ? styles.valueBig : styles.value, tone ? { color: tone } : null]}>{value}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.background },
    content: { padding: 12, gap: 10 },
    // Same insets as the segmented bars elsewhere (ProjectScreen / ProjectCalendarScreen).
    switcher: { paddingBottom: 4 },
    row: { flexDirection: "row", gap: 10 },
    flex: { flex: 1 },
    tile: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 14, padding: 14, gap: 6 },
    tileLabel: { ...typeScale.overline, color: t.textTertiary },
    valueRow: { flexDirection: "row", alignItems: "baseline", gap: 8 },
    value: { fontSize: 26, fontWeight: "700", color: t.textPrimary },
    valueBig: { fontSize: 40, fontWeight: "700", color: t.textPrimary },
    detail: { ...typeScale.caption, color: t.textSecondary },
    heading: { ...typeScale.overline, color: t.textTertiary, marginTop: 8 },
    card: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 14, padding: 14, gap: 12 },
    colRow: { gap: 6 },
    colHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
    colName: { ...typeScale.body, color: t.textPrimary, flexShrink: 1 },
    colCount: { ...typeScale.body, color: t.textSecondary, fontWeight: "600" },
    track: { height: 6, borderRadius: 3, backgroundColor: t.surface3, overflow: "hidden" },
    fill: { height: 6, borderRadius: 3 },
  });
}
