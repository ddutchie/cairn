import { useEffect, useState } from "react";
import { PixelRatio, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { MorphingText } from "@/components/animations/MorphingText";
import { nextIndex } from "@/lib/motion";
import { useMotion, useScreenActive, useScreenReader } from "@/lib/use-motion";

/** Time each hint stays up before morphing to the next. */
const CYCLE_MS = 4000;

/**
 * Drives a rotating placeholder. `visible` is true only when cycling is allowed: the field is
 * empty and unfocused, there is more than one hint, the screen is focused, and neither reduce
 * motion nor a screen reader is on. When false the caller shows a plain static placeholder
 * (hints[0]), so the field always has one accessible string.
 */
export function useHintCycle(hints: readonly string[], enabled: boolean): { visible: boolean; hint: string } {
  const motion = useMotion();
  const screenReader = useScreenReader();
  const active = useScreenActive();
  const visible = enabled && active && !motion.reduced && !screenReader && hints.length > 1;
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => setIndex((i) => nextIndex(i, hints.length)), CYCLE_MS);
    return () => clearInterval(id);
  }, [visible, hints.length]);

  return { visible, hint: hints[Math.min(index, hints.length - 1)] ?? "" };
}

/**
 * The cycling hint itself, drawn over the empty field with the app's `MorphingText` so there is
 * one text-morph engine. Lay it over the input's text area; it never takes touches.
 */
export function HintOverlay({
  hint,
  hints,
  color,
  fontSize,
  style,
}: {
  hint: string;
  hints: readonly string[];
  color: string;
  /** Point size from the `type` scale; scaled here by the user's font-size setting. */
  fontSize: number;
  style?: StyleProp<ViewStyle>;
}) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const size = fontSize * PixelRatio.getFontScale();
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, style]}
      onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
    >
      {box && box.w > 0 ? (
        <MorphingText text={hint} fitTexts={hints} width={box.w} height={box.h} color={color} fontSize={size} align="start" blurMax={4} />
      ) : null}
    </View>
  );
}
