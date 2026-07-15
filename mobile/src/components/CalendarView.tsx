/* eslint-disable react-hooks/refs -- The shared drag controller (src/dnd) bundles
   reanimated SharedValues alongside plain state + ref-callbacks. The react-hooks
   `refs` rule mis-flags every `ctrl.*` member access as ref access because of the
   SharedValues, but those are reanimated UI-thread values only ever read inside
   worklets / useAnimatedStyle — never during JS render. The plain fields
   (ctrl.dragging, ctrl.scrollLocked, ctrl.setContainer) are safe to read here. */
import { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
import { ChevronLeft, ChevronRight, AlertTriangle } from "lucide-react-native";
import Animated from "react-native-reanimated";
import { useDragController, DragOverlay } from "@/dnd";
import { tagsByRow, type CalendarCard } from "@/db/queries";
import { useTheme, iconSize } from "@/theme";
import { formatDate } from "@cairn/shared/format/date";
import { resolveDateDrop } from "@cairn/shared/calendar/dnd";
import { dayKey, dueDayKey, buildMonthGrid, buildWeekGrid, formatDayLabel } from "./calendar/grid";
import { useCalendarStyles } from "./calendar/styles";
import { TaskChip } from "./calendar/TaskChip";
import { DraggableChip } from "./calendar/DraggableChip";
import { DayCell } from "./calendar/DayCell";
import { DayDetailRow } from "./calendar/DayDetailRow";
import { UnscheduledTray } from "./calendar/UnscheduledTray";

export type CalendarLayout = "month" | "week";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Stable empty-cards reference so the `unscheduled` default doesn't churn memos. */
const EMPTY_CARDS: CalendarCard[] = [];

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
  unscheduled = EMPTY_CARDS,
  onReschedule,
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
  /** Cards with no due date, shown in the Unscheduled tray. Drag one onto a day
   *  to schedule it. Omit to hide the tray. */
  unscheduled?: CalendarCard[];
  /** Commit a drag-reschedule: `dueDate` is a "yyyy-MM-dd" key, or null to
   *  clear (dropped on the Unscheduled tray). Omit to disable drag-to-reschedule. */
  onReschedule?: (cardId: string, dueDate: string | null) => void;
}) {
  const t = useTheme();
  const styles = useCalendarStyles();

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
  // its tasks instead of appearing empty. Cards in a done column are complete,
  // so they're kept out of the overdue tray (they still keep their day chip).
  const { byDay, overdue } = useMemo(() => {
    const map = new Map<string, CalendarCard[]>();
    const over: CalendarCard[] = [];
    for (const c of cards) {
      const key = dueDayKey(c.due_date);
      if (!key) continue;
      const arr = map.get(key);
      if (arr) arr.push(c);
      else map.set(key, [c]);
      if (key < todayKey && !c.is_done) over.push(c);
    }
    return { byDay: map, overdue: over };
  }, [cards, todayKey]);

  const cells = useMemo(
    () => (layout === "month" ? buildMonthGrid(anchor, todayKey) : buildWeekGrid(anchor, todayKey)),
    [layout, anchor, todayKey],
  );

  const selectedCards = useMemo(() => byDay.get(selectedKey) ?? [], [byDay, selectedKey]);

  // Resolve tags for the selected day's cards in one query (memoised), so each
  // DayDetailRow doesn't fire its own tagsForCard() during render.
  const selectedTagMap = useMemo(() => tagsByRow(selectedCards), [selectedCards]);

  const maxVisible = layout === "month" ? 2 : 6;

  // Drag-to-reschedule (shared drag core). Drop zones are each day cell (keyed
  // by its yyyy-MM-dd key) plus the Unscheduled tray (UNSCHEDULED_DROP_ID). On
  // release we resolve the drop against the card's current due date and, when
  // it's a real change, hand the new value (or null to clear) to onReschedule.
  // Disabled entirely when the screen doesn't pass onReschedule.
  const dragEnabled = !!onReschedule;
  const ctrl = useDragController<CalendarCard>({
    getId: (c) => c.id,
    // Lift the chip well clear of the finger so it stays readable; the tail
    // (rendered in the overlay below) points down to the actual drop point.
    liftOffsetY: 52,
    onDrop: (card, target) => {
      const patch = resolveDateDrop(target, { dueDate: card.due_date || null });
      if (patch) onReschedule?.(card.id, patch.dueDate ?? null);
    },
  });

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
    <View ref={ctrl.setContainer} style={styles.root} collapsable={false}>
      {/* Toolbar */}
      <View style={styles.toolbar}>
        <View style={styles.navGroup}>
          <Pressable
            onPress={() => step(-1)}
            hitSlop={8}
            style={styles.iconBtn}
            accessibilityRole="button"
            accessibilityLabel="Previous"
          >
            <ChevronLeft size={iconSize.nav} color={t.textSecondary} />
          </Pressable>
          <Pressable
            onPress={() => step(1)}
            hitSlop={8}
            style={styles.iconBtn}
            accessibilityRole="button"
            accessibilityLabel="Next"
          >
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
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.overdueRow}
            // Lock the horizontal scroll while a chip is lifted so the drag
            // gesture isn't stolen by the scroll view.
            scrollEnabled={!ctrl.scrollLocked}
          >
            {overdue.map((card) => (
              <View key={card.id} style={styles.overdueChipWrap}>
                <DraggableChip
                  card={card}
                  // Source zone = the card's (past) due day. Dropping it back on
                  // that same day is a no-op; dropping on another day / the
                  // Unscheduled tray reschedules or clears it.
                  sourceZoneId={dueDayKey(card.due_date)}
                  ctrl={ctrl}
                  dragEnabled={dragEnabled}
                  overdue
                  onPress={() => onOpenCard(card.id)}
                  t={t}
                  styles={styles}
                />
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
      <Animated.ScrollView
        ref={ctrl.scrollRef}
        onScroll={ctrl.scrollHandler}
        onLayout={ctrl.onScrollLayout}
        onContentSizeChange={ctrl.onScrollContentSizeChange}
        scrollEventThrottle={16}
        style={styles.gridScroll}
        contentContainerStyle={{ paddingBottom: bottomInset + 16 }}
        showsVerticalScrollIndicator={false}
        scrollEnabled={!ctrl.scrollLocked}
      >
        <View style={styles.grid}>
          {cells.map((cell) => (
            <DayCell
              key={cell.key}
              cell={cell}
              cards={byDay.get(cell.key) ?? EMPTY_CARDS}
              maxVisible={maxVisible}
              selected={cell.key === selectedKey}
              layoutWeek={layout === "week"}
              dragEnabled={dragEnabled}
              ctrl={ctrl}
              onSelect={setSelectedKey}
              t={t}
              styles={styles}
            />
          ))}
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
                tags={selectedTagMap.get(card.id)}
                showProject={showProject}
                onPress={() => onOpenCard(card.id)}
                t={t}
                styles={styles}
              />
            ))
          )}
        </View>

        {/* Unscheduled tray — droppable list of undated tasks. Drag a chip onto
            a day to schedule it; drag a dated task here to clear its due date. */}
        {dragEnabled ? (
          <UnscheduledTray
            cards={unscheduled}
            ctrl={ctrl}
            showProject={showProject}
            onOpenCard={onOpenCard}
            t={t}
            styles={styles}
          />
        ) : null}
      </Animated.ScrollView>

      {/* Floating clone that follows the finger while a chip is lifted. Lifted
          above the finger (liftOffsetY) with a small tail pointing down to the
          drop point, so the chip stays readable and unobscured. */}
      {ctrl.dragging ? (
        <DragOverlay ctrl={ctrl} scale={1.06}>
          <View>
            <TaskChip card={ctrl.dragging} onPress={() => {}} t={t} styles={styles} lifted />
            <View style={styles.dragTail} />
          </View>
        </DragOverlay>
      ) : null}
    </View>
  );
}
