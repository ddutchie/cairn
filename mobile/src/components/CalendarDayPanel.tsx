import { useCallback, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { listCardsWithDueDates, listUnscheduledCards, tagsByRow, type CalendarCard } from "@/db/queries";
import { dayKey, dueDayKey, formatDayLabel } from "@/components/calendar/grid";
import { DayDetailRow } from "@/components/calendar/DayDetailRow";
import { useCalendarStyles } from "@/components/calendar/styles";
import { calendarStatus } from "@/lib/project-status";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/**
 * The Calendar's overflow in the split view's detail column (wide layouts): a KPI strip
 * (today / week / month / overdue) and the selected day's tasks, beside the grid. The
 * owner re-keys it when a task is rescheduled so the numbers and list follow.
 */
export function CalendarDayPanel({
  projectId,
  selectedKey,
  onOpenCard,
}: {
  projectId: string;
  selectedKey: string;
  onOpenCard: (id: string) => void;
}) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const calStyles = useCalendarStyles();
  const [dated, setDated] = useState<CalendarCard[]>(() => listCardsWithDueDates(projectId));
  const [unscheduled, setUnscheduled] = useState<CalendarCard[]>(() => listUnscheduledCards(projectId));
  const load = useCallback(() => {
    setDated(listCardsWithDueDates(projectId));
    setUnscheduled(listUnscheduledCards(projectId));
  }, [projectId]);
  useRefreshOnFocus(load);

  const cal = useMemo(
    () => calendarStatus(dated, unscheduled.filter((c) => !c.is_done).length, dayKey(new Date())),
    [dated, unscheduled],
  );
  const dayCards = useMemo(() => dated.filter((c) => dueDayKey(c.due_date) === selectedKey), [dated, selectedKey]);
  const tagMap = useMemo(() => tagsByRow(dayCards), [dayCards]);
  const cells = [
    { label: "Today", value: cal.today, accent: t.accent, caption: cal.today ? "due today" : "nothing due" },
    { label: "This week", value: cal.week, accent: t.info, caption: "open tasks" },
    { label: "This month", value: cal.month, accent: t.success, caption: "open tasks" },
    { label: "Overdue", value: cal.overdue, accent: t.danger, caption: cal.overdue ? "need a new date" : "all caught up", tone: cal.overdue ? t.danger : undefined },
  ];

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="never">
      <View style={styles.strip}>
        {cells.map((c, i) => (
          <View
            key={c.label}
            style={[styles.cell, i % 2 === 0 && { borderRightWidth: StyleSheet.hairlineWidth }, i < 2 && { borderBottomWidth: StyleSheet.hairlineWidth }]}
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
      <View style={calStyles.dayList}>
        <Text style={calStyles.dayListTitle}>{formatDayLabel(selectedKey)}</Text>
        {dayCards.length === 0 ? (
          <Text style={calStyles.dayListEmpty}>No tasks due this day.</Text>
        ) : (
          dayCards.map((card) => (
            <DayDetailRow key={card.id} card={card} tags={tagMap.get(card.id)} showProject={false} onPress={() => onOpenCard(card.id)} t={t} styles={calStyles} />
          ))
        )}
      </View>
    </ScrollView>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.background },
    content: { padding: 12, gap: 14, paddingBottom: 32 },
    // Mirrors the Overview's KPI strip (OverviewTab kpiStrip / kpiCell).
    strip: { borderWidth: 1, borderColor: t.border, backgroundColor: t.surface, borderRadius: 12, overflow: "hidden", flexDirection: "row", flexWrap: "wrap" },
    cell: { width: "50%", padding: 12, gap: 2, borderColor: t.border },
    accent: { position: "absolute", top: 0, left: 0, right: 0, height: 3 },
    cellLabel: { fontSize: 10, fontWeight: "600", letterSpacing: 0.5, color: t.textTertiary },
    cellValue: { ...typeScale.heading, color: t.textPrimary, marginTop: 4 },
    cellCaption: { ...typeScale.caption, color: t.textTertiary, fontSize: 11, marginTop: 2 },
  });
}
