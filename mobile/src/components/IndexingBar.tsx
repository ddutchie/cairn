import { useEffect, useMemo, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { useIndexStatus } from "@/notes/useIndexStatus";

/**
 * A slim progress bar shown while the on-device semantic index is catching up
 * (fresh install, import, or a sync that pulled in new notes). Renders nothing
 * once idle, so it's inert in the common already-indexed case. The bar width
 * animates to `done/total`; an indeterminate sliver shows before the total is
 * known.
 */
export function IndexingBar() {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const { running, done, total } = useIndexStatus();
  // Animated.Value held in state (not a ref) so it's a stable instance and the
  // lint "no ref access during render" rule is satisfied when we interpolate.
  const [progress] = useState(() => new Animated.Value(0));

  const ratio = total > 0 ? done / total : 0;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: ratio,
      duration: 240,
      useNativeDriver: false,
    }).start();
  }, [ratio, progress]);

  // Before total is known (ratio 0), show a thin sliver so the bar reads as
  // "working" rather than empty/stuck.
  const width = useMemo(
    () =>
      progress.interpolate({
        inputRange: [0, 1],
        outputRange: total > 0 ? ["0%", "100%"] : ["8%", "8%"],
      }),
    [progress, total],
  );

  if (!running) return null;

  return (
    <View style={styles.wrap} accessibilityRole="progressbar" accessibilityLabel="Building semantic search index">
      <View style={styles.track}>
        <Animated.View style={[styles.fill, { width }]} />
      </View>
      <Text style={styles.label} numberOfLines={1}>
        {total > 0 ? `Indexing for semantic search… ${done}/${total}` : "Preparing semantic search…"}
      </Text>
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    wrap: { paddingHorizontal: 12, paddingTop: 10, gap: 6 },
    track: {
      height: 3,
      borderRadius: 2,
      backgroundColor: t.border,
      overflow: "hidden",
    },
    fill: { height: 3, borderRadius: 2, backgroundColor: t.accent },
    label: { ...typeScale.caption, color: t.textTertiary },
  });
}
