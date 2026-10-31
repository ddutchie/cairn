import { memo, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, {
  FadeIn,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { RollingText } from "@/components/RollingText";
import { foldHalves } from "@/lib/fold";
import { PARTICLE_STRIDE } from "@/lib/game-feel";
import { useFold } from "@/lib/use-fold";
import { useMotion } from "@/lib/use-motion";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/**
 * Shared motion pieces for the hidden Breakout and Stacker games. Everything here animates on
 * the UI thread from shared values, so the games' rAF loops write numbers and React never
 * re-renders per frame.
 */

/** Pool size for {@link ParticlePool}; the game's burst sizes stay under it. */
export const PARTICLE_POOL = 48;

/**
 * Fixed pool of dots driven by one packed buffer (see `packParticles`). Each pooled view reads
 * its own slot, so a burst costs no React renders. `offsetY` lets a camera scroll them.
 */
export function ParticlePool({
  data,
  palette,
  offsetY,
  pool = PARTICLE_POOL,
}: {
  data: SharedValue<number[]>;
  palette: readonly string[];
  offsetY?: SharedValue<number>;
  pool?: number;
}) {
  const slots = useMemo(() => Array.from({ length: pool }, (_, i) => i), [pool]);
  return (
    <>
      {slots.map((i) => (
        <Dot key={i} slot={i} data={data} palette={palette} offsetY={offsetY} />
      ))}
    </>
  );
}

const Dot = memo(function Dot({
  slot,
  data,
  palette,
  offsetY,
}: {
  slot: number;
  data: SharedValue<number[]>;
  palette: readonly string[];
  offsetY?: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => {
    const d = data.get();
    const o = slot * PARTICLE_STRIDE;
    const life = d[o + 2] ?? 0;
    const size = d[o + 3] ?? 0;
    return {
      opacity: life,
      width: size,
      height: size,
      borderRadius: size / 2,
      backgroundColor: palette[d[o + 4] ?? 0] ?? palette[0],
      transform: [{ translateX: (d[o] ?? 0) - size / 2 }, { translateY: (d[o + 1] ?? 0) - size / 2 + (offsetY ? offsetY.get() : 0) }],
    };
  });
  return <Animated.View pointerEvents="none" style={[dotStyle.dot, style]} />;
});

const dotStyle = StyleSheet.create({ dot: { position: "absolute", left: 0, top: 0 } });

/**
 * A quick horizontal shake for a miss. Returns the style to put on the playfield and a trigger.
 * Reduce motion leaves the field still (the haptic and overlay still say what happened).
 */
export function useShake() {
  const motion = useMotion();
  const x = useSharedValue(0);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }));
  const shake = useCallback(() => {
    if (motion.reduced) return;
    x.set(
      withSequence(
        withTiming(-8, { duration: 30 }),
        withTiming(7, { duration: 40 }),
        withTiming(-5, { duration: 40 }),
        withTiming(3, { duration: 40 }),
        withTiming(0, { duration: 35 }),
      ),
    );
  }, [motion.reduced, x]);
  return { style, shake };
}

/** A chip that springs up whenever `pulseKey` changes (a streak ticking, a new best). */
export function PopChip({ pulseKey, children }: { pulseKey: number; children: ReactNode }) {
  const motion = useMotion();
  const s = useSharedValue(1);
  useEffect(() => {
    if (pulseKey <= 0 || motion.reduced) return;
    s.set(withSequence(withTiming(1.2, { duration: 45 }), withSpring(1, { damping: 12, stiffness: 520 })));
  }, [pulseKey, motion.reduced, s]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: s.get() }] }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

/** A line of text that floats up and fades once each time `fireKey` changes (0 = idle). */
export function FloatText({
  fireKey,
  text,
  color,
  top,
  left,
}: {
  fireKey: number;
  text: string;
  color: string;
  top: number;
  /** Horizontal centre of the text. */
  left: number;
}) {
  const motion = useMotion();
  const p = useSharedValue(1);
  useEffect(() => {
    if (fireKey <= 0 || motion.reduced) return;
    p.set(0);
    p.set(withTiming(1, { duration: 520 }));
  }, [fireKey, motion.reduced, p]);
  const style = useAnimatedStyle(() => {
    const v = p.get();
    return {
      opacity: v >= 1 ? 0 : v < 0.15 ? v / 0.15 : 1 - (v - 0.15) / 0.85,
      transform: [{ translateY: -v * 34 }, { scale: 0.9 + Math.min(1, v * 6) * 0.2 }],
    };
  });
  return (
    <Animated.Text pointerEvents="none" style={[floatStyle.text, { top, left: left - FLOAT_W / 2, color }, style]}>
      {text}
    </Animated.Text>
  );
}

const FLOAT_W = 140;
const floatStyle = StyleSheet.create({
  text: { position: "absolute", width: FLOAT_W, textAlign: "center", ...typeScale.control, fontWeight: "800" },
});

/**
 * The end-of-run card: scrim fades in, then the title, score, best line and buttons rise one
 * after another. The score rolls up like the HUD counter. `recordLine` pops when set.
 */
export function GameOverCard({
  title,
  score,
  scoreLabel,
  bestLine,
  record,
  primaryLabel,
  onPrimary,
  onClose,
}: {
  title: string;
  score: number;
  scoreLabel: string;
  bestLine?: string;
  record?: boolean;
  primaryLabel: string;
  onPrimary: () => void;
  onClose: () => void;
}) {
  const t = useTheme();
  // Folded (iPhone Duo): centre the card in the first half so it never sits on the crease.
  const fold = useFold();
  const { width: W, height: H } = useWindowDimensions();
  const halfInset = useMemo(() => {
    if (!fold) return null;
    const extent = fold.axis === "vertical" ? W : H;
    const room = foldHalves(fold, extent).before;
    return fold.axis === "vertical" ? { paddingRight: extent - room } : { paddingBottom: extent - room };
  }, [fold, W, H]);
  const motion = useMotion();
  const styles = useMemo(() => makeStyles(t), [t]);
  const rise = (i: number) => (motion.reduced ? undefined : FadeInDown.delay(40 + i * 55).springify().damping(18).stiffness(300));
  return (
    <Animated.View
      entering={motion.reduced ? undefined : FadeIn.duration(120)}
      style={[styles.overlay, halfInset]}
      pointerEvents="box-none"
    >
      <Animated.Text entering={rise(0)} style={styles.title}>
        {title}
      </Animated.Text>
      <Animated.View entering={rise(1)} style={styles.scoreRow}>
        <Text style={styles.scoreLabel}>{scoreLabel}</Text>
        <RollingText text={String(score)} style={styles.scoreValue} />
      </Animated.View>
      {bestLine ? (
        <Animated.View entering={rise(2)}>
          <PopChip pulseKey={record ? 1 : 0}>
            <View style={[styles.best, record && styles.bestRecord]}>
              <Text style={[styles.bestText, record && styles.bestTextRecord]}>{bestLine}</Text>
            </View>
          </PopChip>
        </Animated.View>
      ) : null}
      <Animated.View entering={rise(3)} style={styles.actions}>
        <Pressable onPress={onPrimary} style={styles.primary} accessibilityRole="button">
          <Text style={styles.primaryText}>{primaryLabel}</Text>
        </Pressable>
        <Pressable onPress={onClose} hitSlop={12} style={styles.close} accessibilityRole="button">
          <Text style={styles.closeText}>Close</Text>
        </Pressable>
      </Animated.View>
    </Animated.View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    overlay: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.scrim,
    },
    title: { ...typeScale.display, color: t.textPrimary },
    scoreRow: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 6 },
    scoreLabel: { ...typeScale.subtitle, color: t.textSecondary },
    scoreValue: { ...typeScale.subtitle, color: t.textPrimary },
    best: {
      marginTop: 10,
      paddingHorizontal: 12,
      paddingVertical: 5,
      borderRadius: 999,
      backgroundColor: t.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
    },
    bestRecord: { backgroundColor: t.accent, borderColor: t.accent },
    bestText: { ...typeScale.caption, color: t.textSecondary, fontVariant: ["tabular-nums"] },
    bestTextRecord: { color: t.accentFg, fontWeight: "700" },
    actions: { alignItems: "center", marginTop: 24 },
    primary: { backgroundColor: t.accent, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
    primaryText: { ...typeScale.control, color: t.accentFg },
    close: { marginTop: 14 },
    // textSecondary (not textTertiary) so it stays legible over the scrim.
    closeText: { ...typeScale.control, color: t.textSecondary },
  });
}
