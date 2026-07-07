import { useCallback, useMemo, useRef, useState } from "react";
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
import { tagsForCard, type CardRow, type ColumnRow } from "@/db/queries";
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

  // The card currently lifted (null when idle) and the column the finger hovers.
  const [dragging, setDragging] = useState<CardRow | null>(null);
  const [scrollEnabled, setScrollEnabled] = useState(true);
  const hoverColId = useSharedValue<string | null>(null);
  const [hoverColJs, setHoverColJs] = useState<string | null>(null);
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
      setHoverColJs(null);
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
        {columns.map((col) => {
          const colCards = cards.filter((c) => c.column_id === col.id);
          const isHoverTarget = hoverColJs === col.id && dragging?.column_id !== col.id;
          return (
            <View
              key={col.id}
              ref={(node) => measureColumn(col.id, node)}
              style={[styles.column, isHoverTarget && styles.columnHover]}
            >
              <Text style={styles.columnTitle}>
                {col.name} <Text style={styles.count}>{colCards.length}</Text>
              </Text>
              <ScrollView style={styles.columnCards} showsVerticalScrollIndicator={false}>
                {colCards.map((card) => (
                  <DraggableCard
                    key={card.id}
                    card={card}
                    t={t}
                    styles={styles}
                    isLifted={dragging?.id === card.id}
                    frames={frames}
                    hoverColId={hoverColId}
                    sourceColId={sourceColId}
                    dragX={dragX}
                    dragY={dragY}
                    dragW={dragW}
                    onOpen={onOpenCard}
                    onBeginDrag={beginDrag}
                    onEndDrag={endDrag}
                    onHoverChange={setHoverColJs}
                    onRemeasure={remeasure}
                  />
                ))}
                <Pressable style={styles.addCard} onPress={() => onAddCard(col.id)}>
                  <Plus size={14} color={t.textTertiary} />
                  <Text style={styles.addCardText}>New task</Text>
                </Pressable>
              </ScrollView>
            </View>
          );
        })}
      </ScrollView>

      {dragging ? (
        <DragOverlay card={dragging} t={t} styles={styles} dragX={dragX} dragY={dragY} dragW={dragW} originX={originX} originY={originY} />
      ) : null}
    </View>
  );
}

/** The floating clone that follows the finger while a card is lifted. */
function DragOverlay({
  card,
  t,
  styles,
  dragX,
  dragY,
  dragW,
  originX,
  originY,
}: {
  card: CardRow;
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
      <CardBody card={card} t={t} styles={styles} />
    </Animated.View>
  );
}

function DraggableCard({
  card,
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
  onHoverChange,
  onRemeasure,
}: {
  card: CardRow;
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
  onHoverChange: (colId: string | null) => void;
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
      if (col !== null) runOnJS(onHoverChange)(col);
    })
    .onUpdate((e) => {
      "worklet";
      dragX.value = e.absoluteX - dragW.value / 2;
      dragY.value = e.absoluteY - 30;
      const col = columnAt(e.absoluteX);
      if (col !== hoverColId.value) {
        hoverColId.value = col;
        runOnJS(onHoverChange)(col);
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
          <CardBody card={card} t={t} styles={styles} />
        </PressableScale>
      </Animated.View>
    </GestureDetector>
  );
}

function CardBody({ card, t, styles }: { card: CardRow; t: Theme; styles: ReturnType<typeof makeStyles> }) {
  const tags = tagsForCard(card);
  return (
    <>
      <View style={styles.cardTop}>
        <View style={[styles.priorityDot, { backgroundColor: PRIORITY_COLOR[card.priority] ?? t.accent }]} />
        <Text style={styles.cardTitle}>{card.title}</Text>
      </View>
      {card.description ? (
        <Text style={styles.cardDesc} numberOfLines={2}>
          {stripMarkdown(card.description)}
        </Text>
      ) : null}
      {tags.length > 0 ? (
        <View style={{ marginTop: 8 }}>
          <TagChips tags={tags} size="sm" />
        </View>
      ) : null}
    </>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
    emptyText: { ...typeScale.caption, color: t.textTertiary, textAlign: "center" },
    boardScroll: { flex: 1 },
    board: { padding: 12, paddingTop: 0, gap: COLUMN_GAP, flexDirection: "row", alignItems: "stretch", flexGrow: 1 },
    column: { width: COLUMN_WIDTH, backgroundColor: t.surface, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: t.border },
    columnHover: { borderColor: t.accent, backgroundColor: withAlpha(t.accent, 0.06) },
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
