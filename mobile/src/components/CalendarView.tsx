/* eslint-disable react-hooks/refs -- The shared drag controller (src/dnd) bundles
   reanimated SharedValues alongside plain state + ref-callbacks. The react-hooks
   `refs` rule mis-flags every `ctrl.*` member access as ref access because of the
   SharedValues, but those are reanimated UI-thread values only ever read inside
   worklets / useAnimatedStyle — never during JS render. The plain fields
   (ctrl.dragging, ctrl.scrollLocked, ctrl.setContainer) are safe to read here. */
import { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { ChevronLeft, ChevronRight, AlertTriangle, Lock, ChevronDown, Inbox } from "lucide-react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { GestureDetector } from "react-native-gesture-handler";
import { PressableScale } from "@/components/PressableScale";
import { useDragController, useZoneHighlight, DragOverlay, type DragController } from "@/dnd";
import { tagsByRow, type CalendarCard, type TagRow } from "@/db/queries";
import { useTheme, withAlpha, PRIORITY_COLOR, elevation, type as typeScale, iconSize, type Theme } from "@/theme";
import { getDueDateStatus, formatDate } from "@cairn/shared/format/date";
import { resolveDateDrop, UNSCHEDULED_DROP_ID } from "@cairn/shared/calendar/dnd";

export type CalendarLayout = "month" | "week";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Stable empty-cards reference so the `unscheduled` default doesn't churn memos. */
const EMPTY_CARDS: CalendarCard[] = [];

/** Fixed width of the dragged-chip clone, so it looks the same from any source zone. */
const DRAG_CHIP_WIDTH = 150;

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
  lifted,
}: {
  card: CalendarCard;
  overdue?: boolean;
  onPress: () => void;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
  /** Rendered inside the drag overlay — pins a fixed width so it reads well. */
  lifted?: boolean;
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
        lifted && { borderColor: t.accent, ...elevation.lg },
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

/**
 * A draggable task chip inside a day cell. Long-press lifts it (via the shared
 * drag core) so it can be dropped on another day or the Unscheduled tray; a
 * short press just selects the day. When drag is disabled it's a plain chip.
 */
function DraggableChip({
  card,
  sourceZoneId,
  ctrl,
  dragEnabled,
  onPress,
  overdue,
  t,
  styles,
}: {
  card: CalendarCard;
  sourceZoneId: string;
  ctrl: DragController<CalendarCard>;
  dragEnabled: boolean;
  onPress: () => void;
  /** Render with the red overdue styling (overdue tray chips). */
  overdue?: boolean;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
}) {
  const isLifted = dragEnabled && ctrl.dragging?.id === card.id;
  // Hooks are always called (never conditionally) to keep order stable; the
  // gesture is simply not attached when drag is disabled for this screen.
  // Fixed overlay width so the lifted chip reads the same regardless of source
  // zone (a day cell is ~narrow, the Unscheduled tray is full-width — without a
  // fixed width the clone would inherit those very different zone widths).
  const pan = useMemo(() => ctrl.panGesture(card, sourceZoneId, DRAG_CHIP_WIDTH), [ctrl, card, sourceZoneId]);
  const slotStyle = useAnimatedStyle(() => ({ opacity: isLifted ? 0.3 : 1 }), [isLifted]);

  const chip = <TaskChip card={card} overdue={overdue} onPress={onPress} t={t} styles={styles} />;
  if (!dragEnabled) return chip;
  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={slotStyle}>{chip}</Animated.View>
    </GestureDetector>
  );
}

/**
 * A single calendar day cell: registers itself as a drop zone (keyed by its
 * yyyy-MM-dd key), shows a hover-highlight overlay while a chip is dragged over
 * it, and renders its (draggable) task chips.
 */
function DayCell({
  cell,
  cards,
  maxVisible,
  selected,
  layoutWeek,
  dragEnabled,
  ctrl,
  onSelect,
  t,
  styles,
}: {
  cell: Cell;
  cards: CalendarCard[];
  maxVisible: number;
  selected: boolean;
  layoutWeek: boolean;
  dragEnabled: boolean;
  ctrl: DragController<CalendarCard>;
  onSelect: (key: string) => void;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
}) {
  const visible = cards.slice(0, maxVisible);
  const overflow = cards.length - visible.length;
  const hoverStyle = useZoneHighlight(ctrl, cell.key);
  return (
    <Pressable
      ref={dragEnabled ? (node: View | null) => ctrl.registerZone(cell.key, node) : undefined}
      collapsable={false}
      onPress={() => onSelect(cell.key)}
      style={[
        styles.cell,
        layoutWeek && styles.cellWeek,
        { backgroundColor: cell.inMonth ? t.surface : t.background },
        // Match desktop: today + the selected day are shown with a soft accent
        // background wash (no outline). Selected is a touch stronger than today
        // so it still reads distinctly (mobile keeps a selected day to drive the
        // day-detail list below the grid).
        cell.isToday && { backgroundColor: withAlpha(t.accent, 0.08) },
        selected && { backgroundColor: withAlpha(t.accent, 0.16) },
      ]}
    >
      {dragEnabled ? <Animated.View pointerEvents="none" style={[styles.cellHighlight, hoverStyle]} /> : null}
      <View style={styles.cellHeader}>
        <View style={[styles.dayNumWrap, cell.isToday && { backgroundColor: t.accent }]}>
          <Text
            style={[
              styles.dayNum,
              { color: cell.isToday ? t.accentFg : cell.inMonth ? t.textSecondary : t.textTertiary },
            ]}
          >
            {cell.date.getDate()}
          </Text>
        </View>
      </View>
      <View style={styles.cellChips}>
        {visible.map((card) => (
          <DraggableChip
            key={card.id}
            card={card}
            sourceZoneId={cell.key}
            ctrl={ctrl}
            dragEnabled={dragEnabled}
            onPress={() => onSelect(cell.key)}
            t={t}
            styles={styles}
          />
        ))}
        {overflow > 0 ? <Text style={styles.moreText}>+{overflow} more</Text> : null}
      </View>
    </Pressable>
  );
}

/**
 * Droppable Unscheduled tray: undated tasks. Drag a chip out onto a day to
 * schedule it; drag a dated task in to clear its due date. Collapsible.
 */
function UnscheduledTray({
  cards,
  ctrl,
  showProject,
  onOpenCard,
  t,
  styles,
}: {
  cards: CalendarCard[];
  ctrl: DragController<CalendarCard>;
  showProject: boolean;
  onOpenCard: (id: string) => void;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
}) {
  const [open, setOpen] = useState(true);
  const hoverStyle = useZoneHighlight(ctrl, UNSCHEDULED_DROP_ID);
  // In the workspace calendar (showProject) group undated tasks by project so a
  // large backlog is easy to scan; per-project calendars keep a flat list.
  const groups = useMemo(() => {
    if (!showProject) return null;
    const byProject = new Map<string, CalendarCard[]>();
    for (const c of cards) {
      const key = c.project_name || "Unknown project";
      const arr = byProject.get(key);
      if (arr) arr.push(c);
      else byProject.set(key, [c]);
    }
    return [...byProject.entries()]
      .map(([name, items]) => ({ name, items }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [cards, showProject]);

  const renderChip = (card: CalendarCard) => (
    <View key={card.id} style={styles.trayChipWrap}>
      <DraggableChip
        card={card}
        sourceZoneId={UNSCHEDULED_DROP_ID}
        ctrl={ctrl}
        dragEnabled
        onPress={() => onOpenCard(card.id)}
        t={t}
        styles={styles}
      />
    </View>
  );

  return (
    <View
      ref={(node: View | null) => ctrl.registerZone(UNSCHEDULED_DROP_ID, node)}
      collapsable={false}
      style={styles.tray}
    >
      <Animated.View pointerEvents="none" style={[styles.trayHighlight, hoverStyle]} />
      <Pressable style={styles.trayHeader} onPress={() => setOpen((o) => !o)}>
        <ChevronDown size={13} color={t.textSecondary} style={{ transform: [{ rotate: open ? "0deg" : "-90deg" }] }} />
        <Inbox size={13} color={t.textSecondary} />
        <Text style={styles.trayTitle}>Unscheduled</Text>
        <Text style={styles.trayCount}>{cards.length}</Text>
      </Pressable>
      {open ? (
        cards.length === 0 ? (
          <Text style={styles.trayEmpty}>No unscheduled tasks. Drag a task here to clear its due date.</Text>
        ) : (
          <ScrollView
            style={styles.trayScroll}
            nestedScrollEnabled
            showsVerticalScrollIndicator
            // While a chip is lifted the outer grid scroll is locked; keep the
            // tray's own scroll locked too so the drag gesture isn't stolen.
            scrollEnabled={!ctrl.scrollLocked}
          >
            {groups ? (
              groups.map((g) => (
                <View key={g.name} style={styles.trayGroup}>
                  <Text style={styles.trayGroupLabel} numberOfLines={1}>
                    {g.name} <Text style={styles.trayGroupCount}>{g.items.length}</Text>
                  </Text>
                  <View style={styles.trayChips}>{g.items.map(renderChip)}</View>
                </View>
              ))
            ) : (
              <View style={styles.trayChips}>{cards.map(renderChip)}</View>
            )}
          </ScrollView>
        )
      ) : null}
    </View>
  );
}


function DayDetailRow({
  card,
  tags,
  showProject,
  onPress,
  t,
  styles,
}: {
  card: CalendarCard;
  tags?: TagRow[];
  showProject: boolean;
  onPress: () => void;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
}) {
  const shownTags = useMemo(() => (tags ?? []).slice(0, 3), [tags]);
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
          {shownTags.map((tag) => (
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
