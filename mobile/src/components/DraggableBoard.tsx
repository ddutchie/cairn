import { memo, useCallback, useMemo, useRef, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { Plus } from "lucide-react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  runOnJS,
  type SharedValue,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { PressableScale } from "@/components/PressableScale";
import { TagChips } from "@/components/TagChips";
import { useTheme, withAlpha, PRIORITY_COLOR, elevation, type as typeScale, type Theme } from "@/theme";
import { tagsByRow, type CardRow, type ColumnRow, type TagRow } from "@/db/queries";
import { stripMarkdown } from "@cairn/shared/notes/text";

const COLUMN_WIDTH = 260;
const COLUMN_GAP = 12;
const LONG_PRESS_MS = 220;

/** Absolute window frame of a column, captured via measureInWindow. */
type ColumnFrame = { x: number; width: number };

/**
 * Trello-style board with long-press drag-and-drop between columns.
 *
 * A short press opens the card; a long-press (220 ms) lifts it so it follows the
 * finger. While a card is lifted the horizontal board scroll is locked and the
 * column under the finger is highlighted; releasing over a different column
 * commits the move. The heavy work happens on the UI thread via reanimated
 * worklets — only the final moveCardToColumn hop crosses back to JS.
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

  // Resolve tags for every card in ONE query, and group cards by column ONCE —
  // both memoised on `cards` — instead of a per-card `tagsForCard()` query and a
  // per-column `cards.filter()` on every render (the board re-renders each drag
  // frame via setHoverColJs, so this ran N queries + M filters per frame).
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

  // Column window frames keyed by column id, filled lazily on layout. Shared so
  // the gesture worklet can read them without a JS round-trip. We keep the View
  // refs around so we can re-measure right before a drag (measureInWindow in the
  // ref callback alone can read stale coords before layout settles / on scroll).
  const frames = useSharedValue<Record<string, ColumnFrame>>({});
  const colRefs = useRef<Record<string, View | null>>({});
  const containerRef = useRef<View>(null);
  // Window origin of the board container, so we can convert the finger's window
  // coords into container-local coords for the absolutely-positioned overlay.
  const originX = useSharedValue(0);
  const originY = useSharedValue(0);
  const scrollRef = useRef<ScrollView>(null);

  // The card currently lifted (null when idle). Changes only at drag start/end,
  // not per frame — so it never causes the board to re-render mid-drag.
  const [dragging, setDragging] = useState<CardRow | null>(null);
  const [scrollEnabled, setScrollEnabled] = useState(true);
  // Which column the finger is over + the drag's source column. Both are shared
  // values updated entirely on the UI thread by the gesture worklets, and read
  // by each column's useAnimatedStyle to light up the hover target — so hover
  // highlighting never crosses back to JS or re-renders the board.
  const hoverColId = useSharedValue<string | null>(null);
  const sourceColId = useSharedValue<string | null>(null);

  // Absolute pointer position of the lifted card's origin, updated each frame.
  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);
  const dragW = useSharedValue(COLUMN_WIDTH - 20);

  const measureColumn = useCallback(
    (colId: string, node: View | null) => {
      colRefs.current[colId] = node;
    },
    [],
  );

  // Re-measure the board origin + every column's window frame. Called on the JS
  // thread right when a drag begins so hit-testing uses fresh, laid-out coords
  // (measuring in the ref callback alone reads x=0 before layout flushes, which
  // made only the last-settled column a valid drop target).
  const remeasure = useCallback(() => {
    containerRef.current?.measureInWindow((x, y) => {
      originX.value = x;
      originY.value = y;
    });
    const next: Record<string, ColumnFrame> = {};
    let pending = Object.keys(colRefs.current).length;
    if (pending === 0) return;
    for (const id in colRefs.current) {
      const node = colRefs.current[id];
      if (!node) {
        pending -= 1;
        continue;
      }
      node.measureInWindow((x, _y, width) => {
        next[id] = { x, width };
        pending -= 1;
        if (pending === 0) frames.value = next;
      });
    }
  }, [frames, originX, originY]);

  const beginDrag = useCallback(
    (card: CardRow) => {
      setDragging(card);
      setScrollEnabled(false);
    },
    [],
  );

  const endDrag = useCallback(
    (cardId: string, target: string | null, source: string | null) => {
      setDragging(null);
      setScrollEnabled(true);
      if (target && target !== source) onMove(cardId, target);
    },
    [onMove],
  );

  if (columns.length === 0) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyText}>No board columns in this project.</Text>
      </View>
    );
  }

  return (
    <View ref={containerRef} style={{ flex: 1 }} collapsable={false}>
      <ScrollView
        ref={scrollRef}
        horizontal
        scrollEnabled={scrollEnabled}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.board, { paddingBottom: 12 + bottomInset }]}
        style={styles.boardScroll}
      >
        {columns.map((col) => (
          <BoardColumn
            key={col.id}
            column={col}
            cards={cardsByColumn.get(col.id) ?? []}
            tagMap={tagMap}
            draggingId={dragging?.id ?? null}
            hoverColId={hoverColId}
            sourceColId={sourceColId}
            frames={frames}
            dragX={dragX}
            dragY={dragY}
            dragW={dragW}
            t={t}
            styles={styles}
            measureColumn={measureColumn}
            onOpenCard={onOpenCard}
            onAddCard={onAddCard}
            onBeginDrag={beginDrag}
            onEndDrag={endDrag}
            onRemeasure={remeasure}
          />
        ))}
      </ScrollView>

      {dragging ? (
        <DragOverlay card={dragging} tags={tagMap.get(dragging.id)} t={t} styles={styles} dragX={dragX} dragY={dragY} dragW={dragW} originX={originX} originY={originY} />
      ) : null}
    </View>
  );
}

/**
 * A board column: its title/count, the draggable cards, and an "add" button.
 * The column's hover-highlight (border + tint when the finger drags a card over
 * it) is driven by a useAnimatedStyle reading the shared hoverColId — so it
 * lights up on the UI thread without re-rendering the board. Memoised so a
 * drag-start/end (which only flips draggingId) re-renders just the columns whose
 * lifted card actually changed.
 */
const BoardColumn = memo(function BoardColumn({
  column,
  cards,
  tagMap,
  draggingId,
  hoverColId,
  sourceColId,
  frames,
  dragX,
  dragY,
  dragW,
  t,
  styles,
  measureColumn,
  onOpenCard,
  onAddCard,
  onBeginDrag,
  onEndDrag,
  onRemeasure,
}: {
  column: ColumnRow;
  cards: CardRow[];
  tagMap: Map<string, TagRow[]>;
  draggingId: string | null;
  hoverColId: SharedValue<string | null>;
  sourceColId: SharedValue<string | null>;
  frames: SharedValue<Record<string, ColumnFrame>>;
  dragX: SharedValue<number>;
  dragY: SharedValue<number>;
  dragW: SharedValue<number>;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
  measureColumn: (colId: string, node: View | null) => void;
  onOpenCard: (id: string) => void;
  onAddCard: (colId: string) => void;
  onBeginDrag: (card: CardRow) => void;
  onEndDrag: (cardId: string, target: string | null, source: string | null) => void;
  onRemeasure: () => void;
}) {
  const colId = column.id;
  // Highlight when the finger hovers THIS column and it isn't the source column.
  const hoverStyle = useAnimatedStyle(() => {
    const active = hoverColId.value === colId && sourceColId.value !== colId;
    return {
      borderColor: active ? t.accent : t.border,
      backgroundColor: active ? withAlpha(t.accent, 0.06) : t.surface,
    };
  });
  return (
    <Animated.View
      ref={(node: View | null) => measureColumn(colId, node)}
      style={[styles.column, hoverStyle]}
    >
      <Text style={styles.columnTitle}>
        {column.name} <Text style={styles.count}>{cards.length}</Text>
      </Text>
      <ScrollView style={styles.columnCards} showsVerticalScrollIndicator={false}>
        {cards.map((card) => (
          <DraggableCard
            key={card.id}
            card={card}
            tags={tagMap.get(card.id)}
            t={t}
            styles={styles}
            isLifted={draggingId === card.id}
            frames={frames}
            hoverColId={hoverColId}
            sourceColId={sourceColId}
            dragX={dragX}
            dragY={dragY}
            dragW={dragW}
            onOpen={onOpenCard}
            onBeginDrag={onBeginDrag}
            onEndDrag={onEndDrag}
            onRemeasure={onRemeasure}
          />
        ))}
        <Pressable style={styles.addCard} onPress={() => onAddCard(colId)}>
          <Plus size={14} color={t.textTertiary} />
          <Text style={styles.addCardText}>New task</Text>
        </Pressable>
      </ScrollView>
    </Animated.View>
  );
});

/** The floating clone that follows the finger while a card is lifted. */
function DragOverlay({
  card,
  tags,
  t,
  styles,
  dragX,
  dragY,
  dragW,
  originX,
  originY,
}: {
  card: CardRow;
  tags?: TagRow[];
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
  dragX: SharedValue<number>;
  dragY: SharedValue<number>;
  dragW: SharedValue<number>;
  originX: SharedValue<number>;
  originY: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => ({
    position: "absolute",
    top: 0,
    left: 0,
    width: dragW.value,
    // dragX/Y are window coords; subtract the container's window origin so the
    // absolutely-positioned overlay lands under the finger, not below it.
    transform: [
      { translateX: dragX.value - originX.value },
      { translateY: dragY.value - originY.value },
      { scale: 1.04 },
    ],
  }));
  return (
    <Animated.View pointerEvents="none" style={[style, styles.card, styles.cardLiftedOverlay, elevation.xl]}>
      <CardBody card={card} tags={tags} t={t} styles={styles} />
    </Animated.View>
  );
}

const DraggableCard = memo(function DraggableCard({
  card,
  tags,
  t,
  styles,
  isLifted,
  frames,
  hoverColId,
  sourceColId,
  dragX,
  dragY,
  dragW,
  onOpen,
  onBeginDrag,
  onEndDrag,
  onRemeasure,
}: {
  card: CardRow;
  tags?: TagRow[];
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
  isLifted: boolean;
  frames: SharedValue<Record<string, ColumnFrame>>;
  hoverColId: SharedValue<string | null>;
  sourceColId: SharedValue<string | null>;
  dragX: SharedValue<number>;
  dragY: SharedValue<number>;
  dragW: SharedValue<number>;
  onOpen: (id: string) => void;
  onBeginDrag: (card: CardRow) => void;
  onEndDrag: (cardId: string, target: string | null, source: string | null) => void;
  onRemeasure: () => void;
}) {
  const active = useSharedValue(false);

  // Resolve which column an absolute X falls into. Worklet — reads shared frames.
  const columnAt = (absX: number): string | null => {
    "worklet";
    const f = frames.value;
    let match: string | null = null;
    for (const id in f) {
      const frame = f[id];
      if (absX >= frame.x && absX <= frame.x + frame.width) {
        match = id;
        break;
      }
    }
    return match;
  };

  const pan = Gesture.Pan()
    .activateAfterLongPress(LONG_PRESS_MS)
    .onBegin(() => {
      "worklet";
      // Fresh-measure columns + container origin as soon as the finger lands,
      // giving the async measure callbacks time to resolve before activation.
      runOnJS(onRemeasure)();
    })
    .onStart((e) => {
      "worklet";
      active.value = true;
      sourceColId.value = card.column_id;
      dragW.value = frames.value[card.column_id]?.width ? frames.value[card.column_id].width - 20 : 240;
      // absoluteX/Y are window coords; offset so the card sits under the finger.
      dragX.value = e.absoluteX - dragW.value / 2;
      dragY.value = e.absoluteY - 30;
      const col = columnAt(e.absoluteX);
      hoverColId.value = col;
      runOnJS(onBeginDrag)(card);
    })
    .onUpdate((e) => {
      "worklet";
      dragX.value = e.absoluteX - dragW.value / 2;
      dragY.value = e.absoluteY - 30;
      const col = columnAt(e.absoluteX);
      // Update the shared hover id only when it changes; the column's
      // useAnimatedStyle reacts on the UI thread — no JS round-trip / re-render.
      if (col !== hoverColId.value) {
        hoverColId.value = col;
      }
    })
    .onEnd(() => {
      "worklet";
      active.value = false;
      runOnJS(onEndDrag)(card.id, hoverColId.value, sourceColId.value);
      hoverColId.value = null;
      sourceColId.value = null;
    })
    .onFinalize(() => {
      "worklet";
      if (active.value) {
        active.value = false;
        runOnJS(onEndDrag)(card.id, null, sourceColId.value);
      }
    });

  // The in-place slot dims to a ghost while its card is lifted out.
  const slotStyle = useAnimatedStyle(() => ({
    opacity: isLifted ? 0.28 : 1,
  }));

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
  // Tags are resolved once by the parent (tagsByRow) and passed in; the desc is
  // stripped once per card (memoised) rather than on every board re-render.
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
