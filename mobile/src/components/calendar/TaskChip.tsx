import { View, Text } from "react-native";
import { Lock } from "lucide-react-native";
import { PressableScale } from "@/components/PressableScale";
import { withAlpha, PRIORITY_COLOR, elevation, type Theme } from "@/theme";
import type { CalendarCard } from "@/db/queries";
import type { CalendarStyles } from "./styles";

/** Compact task chip inside a day cell or tray — matches desktop TaskChip. */
export function TaskChip({
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
  styles: CalendarStyles;
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
        // Day-cell chips live in fixed-height grid rows, so cap how far the OS
        // text-size setting can enlarge them — otherwise at max Dynamic Type the
        // glyphs outgrow the chip's line box and get clipped top & bottom.
        maxFontSizeMultiplier={1.3}
      >
        {card.title}
      </Text>
      {blocked ? <Lock size={9} color={t.warning} /> : null}
    </PressableScale>
  );
}
