import { useEffect } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { ArrowDown } from "lucide-react-native";
import { GlassBar, glassActive } from "@/components/GlassBar";
import { KEYBOARD_OPEN_GAP, useTheme } from "@/theme";
import { RestingStickyView } from "./RestingStickyView";

const SIZE = 38;
/** Space between the button and the composer's top edge. */
const COMPOSER_GAP = 10;

/**
 * Floating "jump to latest" button. Rides the keyboard exactly like the
 * composer (same RestingStickyView offsets) and sits just above it; fades and
 * scales in only when the transcript is scrolled away from the end.
 */
export function ScrollToBottomButton({
  visible,
  composerHeight,
  closedLift,
  onPress,
}: {
  visible: boolean;
  composerHeight: number;
  closedLift: number;
  onPress: () => void;
}) {
  const t = useTheme();
  const shown = useSharedValue(visible ? 1 : 0);
  useEffect(() => {
    shown.value = withTiming(visible ? 1 : 0, { duration: 200 });
  }, [visible, shown]);
  const anim = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ scale: 0.8 + 0.2 * shown.value }],
  }));

  return (
    <RestingStickyView
      offset={{ closed: -closedLift, opened: -KEYBOARD_OPEN_GAP }}
      style={[styles.root, { bottom: composerHeight + COMPOSER_GAP }]}
      pointerEvents={visible ? "box-none" : "none"}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
    >
      <Animated.View style={anim}>
        <Pressable onPress={onPress} hitSlop={8} accessibilityRole="button" accessibilityLabel="Scroll to latest message">
          <GlassBar style={[styles.btn, !glassActive && { backgroundColor: t.surface3, borderWidth: 1, borderColor: t.border }]}>
            <View style={styles.icon}>
              <ArrowDown size={16} color={t.textSecondary} />
            </View>
          </GlassBar>
        </Pressable>
      </Animated.View>
    </RestingStickyView>
  );
}

const styles = StyleSheet.create({
  root: { position: "absolute", right: 14 },
  btn: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, overflow: "hidden", borderCurve: "continuous" },
  icon: { flex: 1, alignItems: "center", justifyContent: "center" },
});
