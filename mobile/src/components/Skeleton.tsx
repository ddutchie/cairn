import { useEffect } from "react";
import { View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { useTheme } from "@/theme";

/**
 * A pulsing placeholder block — the mobile analogue of the desktop's
 * `animate-pulse bg-[var(--surface-2)]` skeletons (NoteMarkdownPreview,
 * ChatInput). Renders a rounded surface that gently fades in/out so lists feel
 * like they're loading rather than flashing empty then popping in.
 */
export function Skeleton({
  width,
  height = 14,
  radius = 6,
  style,
}: {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const opacity = useSharedValue(0.5);

  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(1, { duration: 850, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [opacity]);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      style={[
        { width: width ?? "100%", height, borderRadius: radius, backgroundColor: t.surface2 },
        animStyle,
        style,
      ]}
    />
  );
}

/** A skeleton shaped like a project/list row — icon block + two text lines. */
export function SkeletonRow() {
  const t = useTheme();
  return (
    <View style={[styles.row, { backgroundColor: t.surface, borderColor: t.border }]}>
      <Skeleton width={38} height={38} radius={9} />
      <View style={styles.rowBody}>
        <Skeleton width="55%" height={15} />
        <Skeleton width="35%" height={11} style={{ marginTop: 7 }} />
      </View>
    </View>
  );
}

/** A vertical stack of {@link SkeletonRow}s for an initial list load. */
export function SkeletonList({ count = 6 }: { count?: number }) {
  return (
    <View style={styles.list}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { padding: 12, gap: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  rowBody: { flex: 1 },
});
