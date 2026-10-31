import { useEffect, useState } from "react";
import { View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  cancelAnimation,
  Easing,
  makeMutable,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useTheme, withAlpha } from "@/theme";
import { useMotion } from "@/lib/use-motion";

const SWEEP_MS = 1300;
/** Width of the highlight band as a fraction of the block. */
const BAND = 0.6;

/**
 * One clock for every skeleton on screen. Each block derives its sweep position from this single
 * value, so a list of twenty placeholders runs one animation rather than twenty, and they all
 * shimmer in step. Started by the first mounted block, stopped when the last one unmounts.
 */
let shimmer: SharedValue<number> | null = null;
let shimmerUsers = 0;

function getShimmer(): SharedValue<number> {
  if (!shimmer) shimmer = makeMutable(0);
  return shimmer;
}

function acquireShimmer(): void {
  if (shimmerUsers++ === 0) getShimmer().set(withRepeat(withTiming(1, { duration: SWEEP_MS, easing: Easing.inOut(Easing.ease) }), -1, false));
}

function releaseShimmer(): void {
  if (--shimmerUsers === 0 && shimmer) {
    cancelAnimation(shimmer);
    shimmer.set(0);
  }
}

/**
 * A shimmering placeholder block — the mobile analogue of the desktop's
 * `animate-pulse bg-[var(--surface-2)]` skeletons (NoteMarkdownPreview,
 * ChatInput). A soft highlight sweeps across a rounded surface so lists feel like they're
 * loading rather than flashing empty then popping in. Reduce motion leaves a still block.
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
  const motion = useMotion();
  const [w, setW] = useState(0);
  const clock = getShimmer();

  useEffect(() => {
    if (motion.reduced) return;
    acquireShimmer();
    return releaseShimmer;
  }, [motion.reduced]);

  const sweep = useAnimatedStyle(() => ({
    transform: [{ translateX: -w * BAND + clock.get() * w * (1 + BAND) }],
  }));

  return (
    <View
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      style={[{ width: width ?? "100%", height, borderRadius: radius, backgroundColor: t.surface2, overflow: "hidden" }, style]}
    >
      {!motion.reduced && w > 0 ? (
        <Animated.View style={[StyleSheet.absoluteFill, { width: w * BAND }, sweep]}>
          <LinearGradient
            colors={[withAlpha(t.surface3, 0), t.surface3, withAlpha(t.surface3, 0)]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      ) : null}
    </View>
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
