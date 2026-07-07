import { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { ChevronLeft, ChevronRight, AlertTriangle, Lock } from "lucide-react-native";
import { PressableScale } from "@/components/PressableScale";
import { tagsForCard, type CalendarCard } from "@/db/queries";
import { useTheme, withAlpha, PRIORITY_COLOR, type as typeScale, iconSize, type Theme } from "@/theme";
import { getDueDateStatus, formatDate } from "@cairn/shared/format/date";

export type CalendarLayout = "month" | "week";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** A single cell in the grid. */
interface Cell {
  key: string;
  date: Date;
  inMonth: boolean;
  isToday: boolean;
}

/** LOCAL `yyyy-MM-dd` key for a Date. */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Parse a card `due_date` (bare `yyyy-MM-dd` or full ISO) to a LOCAL day key.
 * Mirrors getDueDateStatus so a date-only value isn't shifted by UTC-midnight.
 */
function dueDayKey(due: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  const d = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(due);
  if (Number.isNaN(d.getTime())) return "";
  return dayKey(d);
}

/**
 * Build a 6×7 month grid (42 cells) for the month containing `anchor`, padded
 * with leading/trailing adjacent-month days. Sunday-start. Mirrors the desktop
 * buildMonthGrid so the two apps lay out identically.
 */
function buildMonthGrid(anchor: Date, todayKey: string): Cell[] {
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const gridStart = new Date(monthStart);
  gridStart.setDate(1 - monthStart.getDay());
  const cells: Cell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const key = dayKey(d);
    cells.push({ key, date: d, inMonth: d.getMonth() === anchor.getMonth(), isToday: key === todayKey });
  }
  return cells;
}

/** Build a 7-cell week grid (Sunday-start) for the week containing `anchor`. */
function buildWeekGrid(anchor: Date, todayKey: string): Cell[] {
  const weekStart = new Date(anchor);
  weekStart.setDate(anchor.getDate() - anchor.getDay());
  const cells: Cell[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i);
    const key = dayKey(d);
    cells.push({ key, date: d, inMonth: true, isToday: key === todayKey });
  }
  return cells;
}

/**
 * Calendar matching the desktop CalendarView: a month/week grid where each day
 * cell holds its task chips, an overdue tray banner up top, prev/next/Today
 * navigation, and a month/week layout toggle. Tapping a chip opens the card;
 * tapping "+N more" opens the day detail sheet.
 */
export function CalendarView({
  cards,
  onOpenCard,
  showProject = false,
  bottomInset = 0,
  layout: layoutProp,
  onLayoutChange,
  todayNonce = 0,
}: {
  cards: CalendarCard[];
  onOpenCard: (cardId: string) => void;
  showProject?: boolean;
  bottomInset?: number;
  /** Controlled layout (month/week). When provided, the in-body toggle is
   *  hidden and the parent (native toolbar) drives it. */
  layout?: CalendarLayout;
  onLayoutChange?: (layout: CalendarLayout) => void;
  /** Bump this (e.g. from a native "Today" toolbar button) to jump the grid +
   *  selection back to today. */
  todayNonce?: number;
}) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);

  // Layout is controlled when `layoutProp` is supplied, else internal.
  const [layoutInternal, setLayoutInternal] = useState<CalendarLayout>("month");
  const layout = layoutProp ?? layoutInternal;
  const setLayout = (l: CalendarLayout) => {
    if (onLayoutChange) onLayoutChange(l);
    else setLayoutInternal(l);
  };
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [selectedKey, setSelectedKey] = useState<string>(() => dayKey(new Date()));

  // A native "Today" toolbar button bumps `todayNonce`; jump home when it does.
  const firstNonce = useRef(todayNonce);
  useEffect(() => {
    if (todayNonce === firstNonce.current) return;
    firstNonce.current = todayNonce;
    const now = new Date();
    setAnchor(now);
    setSelectedKey(dayKey(now));
  }, [todayNonce]);

  const todayKey = dayKey(new Date());

  // Bucket EVERY dated card by its day. A separate overdue list drives the tray,
  // but past-due cards are ALSO kept in `byDay` so a past day that's still
  // visible in the grid (e.g. a leading-week day from the previous month) shows
  // its tasks instead of appearing empty.
  const { byDay, overdue } = useMemo(() => {
    const map = new Map<string, CalendarCard[]>();
    const over: CalendarCard[] = [];
    for (const c of cards) {
      const key = dueDayKey(c.due_date);
      if (!key) continue;
      const arr = map.get(key);
      if (arr) arr.push(c);
      else map.set(key, [c]);
      if (key < todayKey) over.push(c);
    }
    return { byDay: map, overdue: over };
  }, [cards, todayKey]);

  const cells = useMemo(
    () => (layout === "month" ? buildMonthGrid(anchor, todayKey) : buildWeekGrid(anchor, todayKey)),
    [layout, anchor, todayKey],
  );

  const selectedCards = useMemo(() => byDay.get(selectedKey) ?? [], [byDay, selectedKey]);

  const maxVisible = layout === "month" ? 2 : 6;

  const step = (delta: number) =>
    setAnchor((a) =>
      layout === "month"
        ? new Date(a.getFullYear(), a.getMonth() + delta, 1)
        : new Date(a.getFullYear(), a.getMonth(), a.getDate() + delta * 7),
    );

  const periodLabel =
    layout === "month"
      ? `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`
      : `Week of ${buildWeekGrid(anchor, todayKey)[0].date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  return (
    <View style={styles.root}>
      {/* Toolbar */}
      <View style={styles.toolbar}>
        <View style={styles.navGroup}>
          <Pressable onPress={() => step(-1)} hitSlop={8} style={styles.iconBtn}>
            <ChevronLeft size={iconSize.nav} color={t.textSecondary} />
          </Pressable>
          <Pressable onPress={() => step(1)} hitSlop={8} style={styles.iconBtn}>
            <ChevronRight size={iconSize.nav} color={t.textSecondary} />
          </Pressable>
        </View>
        {/* Today + Month/Week live in the native header toolbar when the parent
            drives layout (onLayoutChange). Only render the in-body controls in
            the uncontrolled/standalone case. */}
        {!onLayoutChange ? (
          <Pressable
            onPress={() => {
              const now = new Date();
              setAnchor(now);
              setSelectedKey(dayKey(now));
            }}
            style={styles.todayBtn}
          >
            <Text style={styles.todayText}>Today</Text>
          </Pressable>
        ) : null}
        <Text style={styles.periodLabel} numberOfLines={1}>
          {periodLabel}
        </Text>

        {/* Month / week toggle */}
        {!onLayoutChange ? (
          <View style={styles.toggle}>
            {(["month", "week"] as const).map((l) => {
              const active = layout === l;
              return (
                <Pressable
                  key={l}
                  onPress={() => setLayout(l)}
                  style={[styles.toggleBtn, active && { backgroundColor: t.accent }]}
                >
                  <Text
                    style={[
                      styles.toggleText,
                      { color: active ? t.accentFg : t.textSecondary },
                    ]}
                  >
                    {l === "month" ? "Month" : "Week"}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>

      {/* Overdue tray */}
      {overdue.length > 0 ? (
        <View style={styles.overdueTray}>
          <View style={styles.overdueHeader}>
            <AlertTriangle size={12} color={t.danger} />
            <Text style={styles.overdueTitle}>
              {overdue.length} overdue {overdue.length === 1 ? "task" : "tasks"}
            </Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.overdueRow}>
            {overdue.map((card) => (
              <View key={card.id} style={styles.overdueChipWrap}>
                <TaskChip card={card} overdue onPress={() => onOpenCard(card.id)} t={t} styles={styles} />
                <Text style={styles.overdueWas}>was {formatDate(card.due_date)}</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {/* Weekday header */}
      <View style={styles.weekHeader}>
        {WEEKDAYS.map((d) => (
          <Text key={d} style={styles.weekday}>
            {d}
          </Text>
        ))}
      </View>

      {/* Grid + selected-day list (scroll together) */}
      <ScrollView
        style={styles.gridScroll}
        contentContainerStyle={{ paddingBottom: bottomInset + 16 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.grid}>
          {cells.map((cell) => {
            const dayCards = byDay.get(cell.key) ?? [];
            const visible = dayCards.slice(0, maxVisible);
            const overflow = dayCards.length - visible.length;
            const selected = cell.key === selectedKey;
            return (
              <Pressable
                key={cell.key}
                onPress={() => setSelectedKey(cell.key)}
                style={[
                  styles.cell,
                  layout === "week" && styles.cellWeek,
                  { backgroundColor: cell.inMonth ? t.surface : t.background },
                  cell.isToday && { backgroundColor: withAlpha(t.accent, 0.08) },
                  selected && { borderColor: t.accent, borderWidth: 1.5 },
                ]}
              >
                <View style={styles.cellHeader}>
                  <View
                    style={[
                      styles.dayNumWrap,
                      cell.isToday && { backgroundColor: t.accent },
                    ]}
                  >
                    <Text
                      style={[
                        styles.dayNum,
                        {
                          color: cell.isToday
                            ? t.accentFg
                            : cell.inMonth
                              ? t.textSecondary
                              : t.textTertiary,
                        },
                      ]}
                    >
                      {cell.date.getDate()}
                    </Text>
                  </View>
                </View>
                <View style={styles.cellChips}>
                  {visible.map((card) => (
                    <TaskChip
                      key={card.id}
                      card={card}
                      onPress={() => setSelectedKey(cell.key)}
                      t={t}
                      styles={styles}
                    />
                  ))}
                  {overflow > 0 ? (
                    <Text style={styles.moreText}>+{overflow} more</Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </View>

        {/* Selected-day item list — the "meet halfway" mobile affordance:
            tapping any day fills this list instead of cramming everything into
            tiny cells or a modal sheet. */}
        <View style={styles.dayList}>
          <Text style={styles.dayListTitle}>{formatDayLabel(selectedKey)}</Text>
          {selectedCards.length === 0 ? (
            <Text style={styles.dayListEmpty}>No tasks due this day.</Text>
          ) : (
            selectedCards.map((card) => (
              <DayDetailRow
                key={card.id}
                card={card}
                showProject={showProject}
                onPress={() => onOpenCard(card.id)}
                t={t}
                styles={styles}
              />
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

/** Format a `yyyy-MM-dd` key as e.g. "Monday, July 7". */
function formatDayLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/** Compact task chip inside a day cell or tray — matches desktop TaskChip. */
function TaskChip({
  card,
  overdue,
  onPress,
  t,
  styles,
}: {
  card: CalendarCard;
  overdue?: boolean;
  onPress: () => void;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
}) {
  const dotColor = PRIORITY_COLOR[card.priority] ?? t.textTertiary;
  const blocked = false; // blocked_by_ids not projected here; kept for parity
  return (
    <PressableScale
      scaleTo={1}
      dimTo={0.6}
      onPress={onPress}
      style={[
        styles.chip,
        overdue
          ? {
              backgroundColor: withAlpha(t.danger, 0.14),
              borderColor: withAlpha(t.danger, 0.3),
            }
          : { backgroundColor: t.surface2, borderColor: t.borderSubtle },
      ]}
    >
      <View style={[styles.chipDot, { backgroundColor: dotColor }]} />
      <Text
        style={[styles.chipText, { color: overdue ? t.danger : t.textPrimary }]}
        numberOfLines={1}
      >
        {card.title}
      </Text>
      {blocked ? <Lock size={9} color={t.warning} /> : null}
    </PressableScale>
  );
}

function DayDetailRow({
  card,
  showProject,
  onPress,
  t,
  styles,
}: {
  card: CalendarCard;
  showProject: boolean;
  onPress: () => void;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
}) {
  const tags = useMemo(() => tagsForCard(card).slice(0, 3), [card]);
  const status = getDueDateStatus(card.due_date);
  const priorityColor = PRIORITY_COLOR[card.priority] ?? t.textTertiary;
  return (
    <PressableScale scaleTo={1} dimTo={0.5} onPress={onPress} style={styles.sheetRow}>
      <View style={[styles.priorityBar, { backgroundColor: priorityColor }]} />
      <View style={styles.sheetRowBody}>
        <Text style={styles.sheetRowTitle} numberOfLines={2}>
          {card.title}
        </Text>
        <View style={styles.sheetRowMeta}>
          {showProject ? (
            <Text style={styles.sheetRowProject} numberOfLines={1}>
              {card.project_name}
            </Text>
          ) : null}
          {status === "today" ? (
            <Text style={[styles.sheetBadge, { color: t.warning }]}>Today</Text>
          ) : null}
          {tags.map((tag) => (
            <View
              key={tag.id}
              style={[
                styles.tagChip,
                { backgroundColor: withAlpha(tag.color, 0.14), borderColor: withAlpha(tag.color, 0.35) },
              ]}
            >
              <View style={[styles.tagDot, { backgroundColor: tag.color }]} />
              <Text style={[styles.tagText, { color: t.textSecondary }]} numberOfLines={1}>
                {tag.name}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </PressableScale>
  );
}

function makeStyles(t: Theme) {
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
  });
}
