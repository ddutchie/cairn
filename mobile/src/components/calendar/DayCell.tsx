import { View, Text, Pressable } from "react-native";
import Animated from "react-native-reanimated";
import { useZoneHighlight, type DragController } from "@/dnd";
import { withAlpha, type Theme } from "@/theme";
import type { CalendarCard } from "@/db/queries";
import { DraggableChip } from "./DraggableChip";
import type { Cell } from "./grid";
import type { CalendarStyles } from "./styles";

/**
 * A single calendar day cell: registers itself as a drop zone (keyed by its
 * yyyy-MM-dd key), shows a hover-highlight overlay while a chip is dragged over
 * it, and renders its (draggable) task chips.
 */
export function DayCell({
  cell,
  cards,
  maxVisible,
  selected,
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
  dragEnabled: boolean;
  ctrl: DragController<CalendarCard>;
  onSelect: (key: string) => void;
  t: Theme;
  styles: CalendarStyles;
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
