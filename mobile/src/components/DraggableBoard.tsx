/* eslint-disable react-hooks/refs -- The shared drag controller (src/dnd) bundles
   reanimated SharedValues alongside plain state + ref-callbacks. The react-hooks
   `refs` rule mis-flags every `ctrl.*` member access as ref access because of the
   SharedValues, but those are reanimated UI-thread values only ever read inside
   worklets / useAnimatedStyle — never during JS render. The plain fields
   (ctrl.dragging, ctrl.scrollLocked, ctrl.setContainer) are safe to read here. */
import { memo, useCallback, useMemo } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { Plus } from "lucide-react-native";
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
}: {
  columns: ColumnRow[];
  cards: CardRow[];
  bottomInset: number;
  onMove: (cardId: string, colId: string) => void;
  onOpenCard: (id: string) => void;
  onAddCard: (colId: string) => void;
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
      if (target) onMove(card.id, target);
    },
    [onMove],
  );

  const ctrl = useDragController<CardRow>({ getId: (c) => c.id, onDrop });

  if (columns.length === 0) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyText}>No board columns in this project.</Text>
      </View>
    );
  }

  return (
    <View ref={ctrl.setContainer} style={{ flex: 1 }} collapsable={false}>
      <ScrollView
        horizontal
        scrollEnabled={!ctrl.scrollLocked}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.board, { paddingBottom: 12 + bottomInset }]}
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
      </ScrollView>

      {ctrl.dragging ? (
        <DragOverlay ctrl={ctrl}>
          <BoardDragClone card={ctrl.dragging} tagMap={tagMap} t={t} styles={styles} />
        </DragOverlay>
      ) : null}
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
    board: { padding: 12, paddingTop: 0, gap: COLUMN_GAP, flexDirection: "row", alignItems: "stretch", flexGrow: 1 },
    column: { width: COLUMN_WIDTH, backgroundColor: t.surface, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: t.border },
    columnHighlight: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: 12, borderWidth: 1.5, borderColor: t.accent, backgroundColor: withAlpha(t.accent, 0.06) },
    columnCards: { flex: 1 },
    columnTitle: { fontSize: 14, fontWeight: "700", color: t.textPrimary, marginBottom: 8 },
    count: { color: t.textTertiary, fontWeight: "400" },
    card: { backgroundColor: t.surface2, borderRadius: 8, padding: 10, marginBottom: 8, borderWidth: 1, borderColor: t.borderSubtle },
    cardLiftedOverlay: { borderColor: t.accent, backgroundColor: t.surface2 },
    addCard: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: t.border, borderStyle: "dashed", marginTop: 2 },
    addCardText: { ...typeScale.label, color: t.textTertiary },
    cardTop: { flexDirection: "row", alignItems: "center", gap: 8 },
    priorityDot: { width: 8, height: 8, borderRadius: 4 },
    cardTitle: { flex: 1, ...typeScale.label, fontWeight: "500", color: t.textPrimary },
    cardDesc: { ...typeScale.caption, color: t.textSecondary, marginTop: 8, lineHeight: 17 },
  });
}
