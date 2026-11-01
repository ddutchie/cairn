import { useEffect, useState } from "react";
import { AccessibilityInfo, AppState, StyleSheet } from "react-native";
import { Canvas, Circle, Group, RadialGradient, SweepGradient, useClock, vec } from "@shopify/react-native-skia";
import Animated, { useAnimatedReaction, useAnimatedStyle, useDerivedValue, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { useIsDark, useTheme, withAlpha } from "@/theme";
import { useMotion, useScreenActive } from "@/lib/use-motion";

/** Seconds-per-turn of the slow swirl, and the quiet "breathing" floor while nobody is speaking. */
const SWIRL_MS = 6000;
const BREATH_MS = 2400;
const IDLE_LEVEL = 0.1;
const BREATH_DEPTH = 0.08;
/** How fast the orb follows the mic level (ms); short enough to feel live, long enough not to jitter. */
const FOLLOW_MS = 90;

/** The still pose: a calm resting size, used under Reduce Motion and when the screen is off. */
const REST_LEVEL = 0.2;

const RING_STROKE = 0.08; // of the diameter

interface OrbPaint {
  size: number;
  accent: string;
  core: string;
  halo: string;
}

/** Radii for a 0–1 level, as fractions of the half-size. Worklet-safe (used on the UI thread). */
function radii(level: number) {
  "worklet";
  return { halo: 0.62 + 0.38 * level, core: 0.4 + 0.14 * level, ring: 0.7 + 0.12 * level };
}

function Still({ paint }: { paint: OrbPaint }) {
  const { size, accent, core, halo } = paint;
  const c = size / 2;
  const r = radii(REST_LEVEL);
  return (
    <Canvas style={{ width: size, height: size }}>
      <Circle cx={c} cy={c} r={c * r.halo}>
        <RadialGradient c={vec(c, c)} r={c * r.halo} colors={[halo, withAlpha(accent, 0)]} />
      </Circle>
      <Circle cx={c} cy={c} r={c * r.core} color={accent} />
      <Circle cx={c * 0.88} cy={c * 0.82} r={c * r.core * 0.6}>
        <RadialGradient c={vec(c * 0.88, c * 0.82)} r={c * r.core * 0.6} colors={[core, withAlpha(core, 0)]} />
      </Circle>
    </Canvas>
  );
}

function Live({ paint, level }: { paint: OrbPaint; level: SharedValue<number> }) {
  const { size, accent, core, halo } = paint;
  const c = size / 2;
  const clock = useClock();
  const smooth = useSharedValue(0);

  // Follow the mic on the UI thread: no JS work per frame, none per volume event.
  useAnimatedReaction(
    () => level.get(),
    (v) => smooth.set(withTiming(v, { duration: FOLLOW_MS })),
  );

  const eff = useDerivedValue(() => {
    const breath = IDLE_LEVEL + BREATH_DEPTH * (0.5 + 0.5 * Math.sin((clock.get() / BREATH_MS) * 2 * Math.PI));
    return Math.max(smooth.get(), breath);
  });
  const haloR = useDerivedValue(() => c * radii(eff.get()).halo);
  const coreR = useDerivedValue(() => c * radii(eff.get()).core);
  const ringR = useDerivedValue(() => c * radii(eff.get()).ring);
  const glowR = useDerivedValue(() => c * radii(eff.get()).core * 0.6);
  const swirl = useDerivedValue(() => [{ rotate: (clock.get() / SWIRL_MS) * 2 * Math.PI }]);
  const ringAlpha = useDerivedValue(() => 0.35 + 0.65 * Math.min(1, smooth.get() * 1.5));

  return (
    <Canvas style={{ width: size, height: size }}>
      <Circle cx={c} cy={c} r={haloR}>
        <RadialGradient c={vec(c, c)} r={haloR} colors={[halo, withAlpha(accent, 0)]} />
      </Circle>
      <Group origin={vec(c, c)} transform={swirl} opacity={ringAlpha}>
        <Circle cx={c} cy={c} r={ringR} style="stroke" strokeWidth={size * RING_STROKE}>
          <SweepGradient c={vec(c, c)} colors={[withAlpha(accent, 0), accent, withAlpha(accent, 0)]} />
        </Circle>
      </Group>
      <Circle cx={c} cy={c} r={coreR} color={accent} />
      <Circle cx={c * 0.88} cy={c * 0.82} r={glowR}>
        <RadialGradient c={vec(c * 0.88, c * 0.82)} r={glowR} colors={[core, withAlpha(core, 0)]} />
      </Circle>
    </Canvas>
  );
}

/**
 * A soft accent orb that swells with your voice while dictation is listening. One Skia
 * canvas; the radii, swirl and breathing all derive from the mic `level` and a clock on the UI
 * thread, so nothing runs on the JS thread per frame. Renders nothing when not listening, which
 * also stops the clock. Under Reduce Motion, on a blurred screen or in the background it
 * is a still orb instead. Colours come from the theme (accent over the glass), never fixed.
 */
export function ListeningOrb({ listening, level, size = 40 }: { listening: boolean; level: SharedValue<number>; size?: number }) {
  const t = useTheme();
  const dark = useIsDark();
  const motion = useMotion();
  const focused = useScreenActive();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const presence = useSharedValue(0);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setForeground(s === "active"));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    presence.set(withTiming(listening ? 1 : 0, { duration: motion.ms(180) }));
  }, [listening, motion, presence]);

  useEffect(() => {
    if (listening) AccessibilityInfo.announceForAccessibility("Listening");
  }, [listening]);

  const fade = useAnimatedStyle(() => ({ opacity: presence.get(), transform: [{ scale: 0.85 + 0.15 * presence.get() }] }));

  if (!listening) return null;

  const paint: OrbPaint = { size, accent: t.accent, core: withAlpha(dark ? t.textPrimary : t.surface, 0.45), halo: withAlpha(t.accent, 0.55) };
  const animate = !motion.reduced && focused && foreground;

  return (
    <Animated.View
      pointerEvents="none"
      accessible
      accessibilityRole="image"
      accessibilityLabel="Listening"
      accessibilityLiveRegion="polite"
      style={[styles.box, { width: size, height: size }, fade]}
    >
      {animate ? <Live paint={paint} level={level} /> : <Still paint={paint} />}
    </Animated.View>
  );
}

const styles = StyleSheet.create({ box: { alignItems: "center", justifyContent: "center" } });
