import { memo, useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View, type TextStyle } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { rollTokens } from "@/lib/motion";
import { useMotion } from "@/lib/use-motion";

const ROLL_MS = 520;
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * Odometer-style text: each digit is a reel that rolls from its previous value to the new one;
 * punctuation and letters stay put. Pass the display string ("42", "1,204", "$0.42", "12.3k").
 *
 * - First mount counts up from 0; later changes roll from whatever the reel showed.
 * - Digit cell size is measured from the real text style, so it follows the font-size setting
 *   and Dynamic Type, and `tabular-nums` keeps every cell the same width.
 * - Reduce motion sets the digits instantly.
 * - Read as one string by VoiceOver; the reels are hidden from it.
 */
export function RollingText({ text, style }: { text: string; style: TextStyle | TextStyle[] }) {
  const flat = useMemo(() => StyleSheet.flatten([style, { fontVariant: ["tabular-nums"] as const }]) as TextStyle, [style]);
  const [cell, setCell] = useState<{ w: number; h: number } | null>(null);
  const tokens = useMemo(() => rollTokens(text), [text]);

  return (
    <View accessible accessibilityRole="text" accessibilityLabel={text}>
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        {/* Off-layout probe: the size of one digit in this style at the current font scale. */}
        <Text
          style={[flat, styles.probe]}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            setCell((c) => (c && c.w === width && c.h === height ? c : { w: width, h: height }));
          }}
        >
          0
        </Text>
        {cell ? (
          <View style={[styles.row, { height: cell.h }]}>
            {tokens.map((tk) =>
              tk.digit === null ? (
                <Text key={tk.key} style={[flat, { lineHeight: cell.h }]}>
                  {tk.ch}
                </Text>
              ) : (
                <Reel key={tk.key} digit={tk.digit} w={cell.w} h={cell.h} style={flat} />
              ),
            )}
          </View>
        ) : (
          // Reserve the final width/height until the probe reports, without flashing the end value.
          <Text style={[flat, styles.hidden]}>{text}</Text>
        )}
      </View>
    </View>
  );
}

const Reel = memo(function Reel({ digit, w, h, style }: { digit: number; w: number; h: number; style: TextStyle }) {
  const motion = useMotion();
  // A reel that mounts (first render, or a number gaining a digit) starts at 0 and rolls in.
  const pos = useSharedValue(motion.reduced ? digit : 0);
  useEffect(() => {
    pos.set(motion.reduced ? digit : withTiming(digit, { duration: ROLL_MS, easing: Easing.out(Easing.cubic) }));
  }, [digit, motion.reduced, pos]);
  const column = useAnimatedStyle(() => ({ transform: [{ translateY: -pos.get() * h }] }));
  return (
    <View style={{ width: w, height: h, overflow: "hidden" }}>
      <Animated.View style={column}>
        {DIGITS.map((d) => (
          <Text key={d} style={[style, { height: h, lineHeight: h, textAlign: "center" }]}>
            {d}
          </Text>
        ))}
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: "row" },
  probe: { position: "absolute", opacity: 0 },
  hidden: { opacity: 0 },
});
