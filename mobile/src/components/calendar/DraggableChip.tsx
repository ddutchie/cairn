import { useMemo } from "react";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { GestureDetector } from "react-native-gesture-handler";
import { type DragController } from "@/dnd";
import { type Theme } from "@/theme";
import type { CalendarCard } from "@/db/queries";
import { TaskChip } from "./TaskChip";
import type { CalendarStyles } from "./styles";

/** Fixed width of the dragged-chip clone, so it looks the same from any source zone. */
const DRAG_CHIP_WIDTH = 150;

/**
 * A draggable task chip inside a day cell. Long-press lifts it (via the shared
 * drag core) so it can be dropped on another day or the Unscheduled tray; a
 * short press just selects the day. When drag is disabled it's a plain chip.
 */
export function DraggableChip({
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
  styles: CalendarStyles;
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
