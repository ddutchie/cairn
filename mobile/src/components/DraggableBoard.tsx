/* eslint-disable react-hooks/refs -- The shared drag controller (src/dnd) bundles
   reanimated SharedValues alongside plain state + ref-callbacks. The react-hooks
   `refs` rule mis-flags every `ctrl.*` member access as ref access because of the
   SharedValues, but those are reanimated UI-thread values only ever read inside
   worklets / useAnimatedStyle — never during JS render. The plain fields
   (ctrl.dragging, ctrl.scrollLocked, ctrl.setContainer) are safe to read here. */
import { memo, useCallback, useEffect, useMemo } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { Plus, Archive, Trash2 } from "lucide-react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { GestureDetector } from "react-native-gesture-handler";
import { PressableScale } from "@/components/PressableScale";
import { TagChips } from "@/components/TagChips";
import { useDragController, useZoneHighlight, DragOverlay, type DragController } from "@/dnd";
import { useTheme, withAlpha, PRIORITY_COLOR, elevation, type as typeScale, type Theme } from "@/theme";
import { tagsByRow, type CardRow, type ColumnRow, type TagRow } from "@/db/queries";
import { stripMarkdown } from "@cairn/shared/notes/text";

const COLUMN_WIDTH = 260;
const COLUMN_GAP = 12;

// Special drop-zone ids for the archive / delete action bar. Prefixed so they
// can never collide with a real column id. onDrop routes these to the archive /
// delete handlers instead of a column move.
const ARCHIVE_ZONE = "__archive__";
const DELETE_ZONE = "__delete__";

// Stable empty-array reference for columns with no cards, so BoardColumn's
// memoisation isn't defeated by a fresh `[]` each render.
const EMPTY_CARDS: CardRow[] = [];

/**
 * Trello-style board with long-press drag-and-drop between columns.
 *
 * A short press opens the card; a long-press lifts it so it follows the finger.
 * While a card is lifted the horizontal board scroll is locked and the column
 * under the finger is highlighted; releasing over a different column commits the
 * move. The gesture + hit-testing run on the UI thread via the shared drag core
 * (src/dnd) — the same engine the calendar uses — so only the final
 * moveCardToColumn hop crosses back to JS.
 */
export function DraggableBoard({
  columns,
  cards,
  bottomInset,
  onMove,
  onOpenCard,
  onAddCard,
  onArchive,
  onDelete,
}: {
  columns: ColumnRow[];
  cards: CardRow[];
  bottomInset: number;
  onMove: (cardId: string, colId: string) => void;
  onOpenCard: (id: string) => void;
  onAddCard: (colId: string) => void;
  /** Drop a card on the Archive zone. */
  onArchive?: (card: CardRow) => void;
  /** Drop a card on the Delete zone. */
  onDelete?: (card: CardRow) => void;
}) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);

  // Resolve tags for every card in ONE query and group cards by column ONCE —
  // both memoised on `cards` — instead of a per-card query + per-column filter
  // on every render (the board re-renders on drag start/end).
  const tagMap = useMemo(() => tagsByRow(cards), [cards]);
  const cardsByColumn = useMemo(() => {
    const map = new Map<string, CardRow[]>();
    for (const c of cards) {
      const arr = map.get(c.column_id);
      if (arr) arr.push(c);
      else map.set(c.column_id, [c]);
    }
    return map;
  }, [cards]);

  const onDrop = useCallback(
    (card: CardRow, target: string | null) => {
      if (target === ARCHIVE_ZONE) onArchive?.(card);
      else if (target === DELETE_ZONE) onDelete?.(card);
      else if (target) onMove(card.id, target);
    },
    [onMove, onArchive, onDelete],
  );

  const ctrl = useDragController<CardRow>({ getId: (c) => c.id, onDrop, scrollAxis: "x" });
  // Whether the action bar (archive/delete drop zones) is wired up at all.
  const hasActions = !!onArchive || !!onDelete;

  // The action bar collapses when idle, so its zone frames aren't laid out when
  // the drag core measures on panGesture.onBegin (that fires before the lift).
  // Re-measure once a lift expands the bar so the zones become hittable. A
  // double rAF lets the expanded layout flush before we read the frames.
  const dragging = ctrl.dragging;
  const remeasure = ctrl.remeasure;
  useEffect(() => {
    if (!dragging || !hasActions) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => remeasure());
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [dragging, hasActions, remeasure]);

  if (columns.length === 0) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyText}>No board columns in this project.</Text>
      </View>
    );
  }

  return (
    <View ref={ctrl.setContainer} style={{ flex: 1 }} collapsable={false}>
      <Animated.ScrollView
        ref={ctrl.scrollRef}
        onScroll={ctrl.scrollHandler}
        onLayout={ctrl.onScrollLayout}
        onContentSizeChange={ctrl.onScrollContentSizeChange}
        scrollEventThrottle={16}
        horizontal
        scrollEnabled={!ctrl.scrollLocked}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.board}
        style={styles.boardScroll}
      >
        {columns.map((col) => (
          <BoardColumn
            key={col.id}
            column={col}
            cards={cardsByColumn.get(col.id) ?? EMPTY_CARDS}
            tagMap={tagMap}
            ctrl={ctrl}
            t={t}
            styles={styles}
            onOpenCard={onOpenCard}
            onAddCard={onAddCard}
          />
        ))}
      </Animated.ScrollView>

      {hasActions ? (
        // A real row BELOW the columns (not an overlay), so the drop zones sit
        // in genuinely empty space and a card dropped here can't be mistaken for
        // a column drop. Collapsed to nothing when idle (board keeps full
        // height); expands while a card is lifted. Because it lays out AFTER the
        // lift, useDragController's zones would measure stale — so we re-measure
        // once it's expanded (see the effect below).
        <View
          style={[
            styles.actionBar,
            ctrl.dragging
              ? { paddingBottom: bottomInset, paddingTop: 8 }
              : styles.actionBarCollapsed,
          ]}
          pointerEvents="none"
        >
          {onArchive ? (
            <ActionZone
              zoneId={ARCHIVE_ZONE}
              label="Archive"
              icon={<Archive size={20} color={t.warning} />}
              color={t.warning}
              ctrl={ctrl}
              styles={styles}
            />
          ) : null}
          {onDelete ? (
            <ActionZone
              zoneId={DELETE_ZONE}
              label="Delete"
              icon={<Trash2 size={20} color={t.danger} />}
              color={t.danger}
              ctrl={ctrl}
              styles={styles}
            />
          ) : null}
        </View>
      ) : null}

      {ctrl.dragging ? (
        <DragOverlay ctrl={ctrl}>
          <BoardDragClone card={ctrl.dragging} tagMap={tagMap} t={t} styles={styles} />
        </DragOverlay>
      ) : null}
    </View>
  );
}

/**
 * A drop target in the action bar (Archive / Delete). Registers itself with the
 * drag controller so the shared hit-test picks it up, and lights up (via
 * useZoneHighlight, UI-thread) when the finger hovers it mid-drag. The bar
 * itself is pointerEvents="none" so it never blocks scrolls, but the zones are
 * only measured rectangles — the drag engine hit-tests them by frame, not touch.
 */
function ActionZone({
  zoneId,
  label,
  icon,
  color,
  ctrl,
  styles,
}: {
  zoneId: string;
  label: string;
  icon: React.ReactNode;
  color: string;
  ctrl: DragController<CardRow>;
  styles: ReturnType<typeof makeStyles>;
}) {
  const hoverStyle = useZoneHighlight(ctrl, zoneId);
  return (
    <View
      ref={(node: View | null) => ctrl.registerZone(zoneId, node)}
      style={[styles.actionZone, { borderColor: withAlpha(color, 0.5) }]}
      collapsable={false}
    >
      <Animated.View
        pointerEvents="none"
        style={[styles.actionZoneHighlight, { backgroundColor: withAlpha(color, 0.18), borderColor: color }, hoverStyle]}
      />
      {icon}
      <Text style={[styles.actionZoneLabel, { color }]}>{label}</Text>
    </View>
  );
}

/** The card clone rendered inside the drag overlay. Isolated so the tag lookup
 *  isn't flagged as ref access at the container level. */
function BoardDragClone({
  card,
  tagMap,
  t,
  styles,
}: {
  card: CardRow;
  tagMap: Map<string, TagRow[]>;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={[styles.card, styles.cardLiftedOverlay, elevation.xl]}>
      <CardBody card={card} tags={tagMap.get(card.id)} t={t} styles={styles} />
    </View>
  );
}

/**
 * A board column: title/count, its draggable cards, and an "add" button. The
 * hover-highlight (border + tint when a card is dragged over it) is driven by
 * useZoneHighlight reading the shared hover id — so it lights up on the UI
 * thread without re-rendering the board. Memoised so a drag start/end only
 * re-renders the columns whose lifted card actually changed.
 */
const BoardColumn = memo(function BoardColumn({
  column,
  cards,
  tagMap,
  ctrl,
  t,
  styles,
  onOpenCard,
  onAddCard,
}: {
  column: ColumnRow;
  cards: CardRow[];
  tagMap: Map<string, TagRow[]>;
  ctrl: DragController<CardRow>;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
  onOpenCard: (id: string) => void;
  onAddCard: (colId: string) => void;
}) {
  const colId = column.id;
  const hoverStyle = useZoneHighlight(ctrl, colId);
  const draggingId = ctrl.dragging?.id ?? null;
  return (
    <View ref={(node: View | null) => ctrl.registerZone(colId, node)} style={styles.column} collapsable={false}>
      {/* Hover highlight overlay — an absolutely-filled Animated.View so the
          measured column stays a plain View; reanimated animates the opacity. */}
      <Animated.View pointerEvents="none" style={[styles.columnHighlight, hoverStyle]} />
      <Text style={styles.columnTitle}>
        {column.name} <Text style={styles.count}>{cards.length}</Text>
      </Text>
      <ScrollView style={styles.columnCards} showsVerticalScrollIndicator={false}>
        {cards.map((card) => (
          <DraggableCard
            key={card.id}
            card={card}
            tags={tagMap.get(card.id)}
            ctrl={ctrl}
            isLifted={draggingId === card.id}
            t={t}
            styles={styles}
            onOpen={onOpenCard}
          />
        ))}
        <Pressable style={styles.addCard} onPress={() => onAddCard(colId)}>
          <Plus size={14} color={t.textTertiary} />
          <Text style={styles.addCardText}>New task</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
});

const DraggableCard = memo(function DraggableCard({
  card,
  tags,
  ctrl,
  isLifted,
  t,
  styles,
  onOpen,
}: {
  card: CardRow;
  tags?: TagRow[];
  ctrl: DragController<CardRow>;
  isLifted: boolean;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
  onOpen: (id: string) => void;
}) {
  const pan = useMemo(() => ctrl.panGesture(card, card.column_id), [ctrl, card]);
  // The in-place slot dims to a ghost while its card is lifted out.
  const slotStyle = useAnimatedStyle(() => ({ opacity: isLifted ? 0.28 : 1 }), [isLifted]);
  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={slotStyle}>
        <PressableScale style={[styles.card, elevation.sm]} onPress={() => onOpen(card.id)} disabled={isLifted}>
          <CardBody card={card} tags={tags} t={t} styles={styles} />
        </PressableScale>
      </Animated.View>
    </GestureDetector>
  );
});

const CardBody = memo(function CardBody({
  card,
  tags,
  t,
  styles,
}: {
  card: CardRow;
  tags?: TagRow[];
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
}) {
  const desc = useMemo(() => (card.description ? stripMarkdown(card.description) : ""), [card.description]);
  const shownTags = tags ?? [];
  return (
    <>
      <View style={styles.cardTop}>
        <View style={[styles.priorityDot, { backgroundColor: PRIORITY_COLOR[card.priority] ?? t.accent }]} />
        <Text style={styles.cardTitle}>{card.title}</Text>
      </View>
      {desc ? (
        <Text style={styles.cardDesc} numberOfLines={2}>
          {desc}
        </Text>
      ) : null}
      {shownTags.length > 0 ? (
        <View style={{ marginTop: 8 }}>
          <TagChips tags={shownTags} size="sm" />
        </View>
      ) : null}
    </>
  );
});

function makeStyles(t: Theme) {
  return StyleSheet.create({
    emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
    emptyText: { ...typeScale.caption, color: t.textTertiary, textAlign: "center" },
    boardScroll: { flex: 1 },
    board: { padding: 12, paddingTop: 0, paddingBottom: 12, gap: COLUMN_GAP, flexDirection: "row", alignItems: "stretch", flexGrow: 1 },
    column: { width: COLUMN_WIDTH, backgroundColor: t.surface, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: t.border },
    columnHighlight: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: 12, borderWidth: 1.5, borderColor: t.accent, backgroundColor: withAlpha(t.accent, 0.06) },
    columnCards: { flex: 1 },
    columnTitle: { fontSize: 14, fontWeight: "700", color: t.textPrimary, marginBottom: 8 },
    count: { color: t.textTertiary, fontWeight: "400" },
    card: { backgroundColor: t.surface2, borderRadius: 8, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: t.borderSubtle },
    cardLiftedOverlay: { borderColor: t.accent, backgroundColor: t.surface2 },
    addCard: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: t.border, borderStyle: "dashed", marginTop: 2 },
    addCardText: { ...typeScale.label, color: t.textTertiary },
    cardTop: { flexDirection: "row", alignItems: "center", gap: 8 },
    priorityDot: { width: 8, height: 8, borderRadius: 4 },
    cardTitle: { flex: 1, ...typeScale.label, fontWeight: "500", color: t.textPrimary },
    cardDesc: { ...typeScale.caption, color: t.textSecondary, marginTop: 8, lineHeight: 17 },
    // Action bar: a row of drop zones laid out BELOW the columns (a sibling of
    // the board scroll, not an overlay), so a card dropped here lands in empty
    // space rather than over a column. Collapsed to zero height when idle; the
    // component re-measures the zones after it expands on a lift.
    actionBar: {
      flexDirection: "row",
      gap: 12,
      paddingHorizontal: 12,
      flexShrink: 0,
    },
    actionBarCollapsed: { height: 0, overflow: "hidden", opacity: 0 },
    actionZone: {
      flex: 1,
      height: 64,
      borderRadius: 12,
      borderWidth: 1.5,
      borderStyle: "dashed",
      backgroundColor: t.surface,
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
      overflow: "hidden",
    },
    actionZoneHighlight: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      borderRadius: 12,
      borderWidth: 1.5,
    },
    actionZoneLabel: { ...typeScale.label, fontWeight: "600" },
  });
}
