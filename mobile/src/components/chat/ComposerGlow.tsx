import { useEffect, useState } from "react";
import { StyleSheet } from "react-native";
import Svg, { Rect } from "react-native-svg";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import type { WorkPhase } from "@cairn/shared/conversation/work-phase";
import { useTheme, withAlpha } from "@/theme";
import { useMotion, useScreenActive } from "@/lib/use-motion";

/** One breath, ms. Calmer phases breathe slower; "waiting on you" is the slowest. */
const BREATH_MS: Record<WorkPhase, number> = {
  sending: 2200,
  thinking: 2600,
  responding: 2000,
  tools: 1600,
  working: 2200,
  retrying: 1200,
  compacting: 2800,
  waiting: 3200,
};

/** Peak of the soft outer halo and the thin inner line. Both stay faint on purpose. */
const HALO_ALPHA = 0.18;
const LINE_ALPHA = 0.5;
const HALO_STROKE = 6;
const LINE_STROKE = 1.5;

/**
 * A faint accent halo hugging the composer while a turn runs, breathing at a rate set by the
 * `WorkPhase` (the same one the message loader reads). It fades in when a phase starts and out
 * when it ends. Reduce motion shows a still ring instead; the loop also stops on blur.
 * Drawn as an SVG border so it needs no shader and sits cleanly under the glass.
 */
export function ComposerGlow({ phase, radius }: { phase: WorkPhase | null; radius: number }) {
  const t = useTheme();
  const motion = useMotion();
  const active = useScreenActive();
  const [box, setBox] = useState({ w: 0, h: 0 });
  const presence = useSharedValue(0);
  const breath = useSharedValue(1);
  const on = phase !== null;
  const period = BREATH_MS[phase ?? "working"];
  const breathing = on && active && !motion.reduced;

  useEffect(() => {
    presence.set(withTiming(on ? 1 : 0, { duration: motion.ms(350) }));
  }, [on, motion, presence]);

  useEffect(() => {
    if (!breathing) {
      cancelAnimation(breath);
      breath.set(1);
      return;
    }
    breath.set(
      withRepeat(
        withSequence(withTiming(0.35, { duration: period / 2, easing: Easing.inOut(Easing.sin) }), withTiming(1, { duration: period / 2, easing: Easing.inOut(Easing.sin) })),
        -1,
        false,
      ),
    );
    return () => cancelAnimation(breath);
  }, [breathing, period, breath]);

  const style = useAnimatedStyle(() => ({ opacity: presence.get() * breath.get() }));
  const color = phase === "retrying" ? t.warning : t.accent;
  const inset = HALO_STROKE / 2;

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, style]}
      onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
    >
      {box.w > 0 ? (
        <Svg width={box.w} height={box.h}>
          <Rect x={inset} y={inset} width={box.w - HALO_STROKE} height={box.h - HALO_STROKE} rx={radius} fill="none" stroke={withAlpha(color, HALO_ALPHA)} strokeWidth={HALO_STROKE} />
          <Rect x={inset} y={inset} width={box.w - HALO_STROKE} height={box.h - HALO_STROKE} rx={radius} fill="none" stroke={withAlpha(color, LINE_ALPHA)} strokeWidth={LINE_STROKE} />
        </Svg>
      ) : null}
    </Animated.View>
  );
}
