import { View, Text, StyleSheet } from "react-native";
import { useEffect } from "react";
import Svg, { Circle } from "react-native-svg";
import Animated, { Easing, useAnimatedProps, useSharedValue, withTiming } from "react-native-reanimated";
import { useTheme, type as typeScale } from "@/theme";
import { RollingText } from "@/components/RollingText";
import { useMotion } from "@/lib/use-motion";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const SWEEP_MS = 700;

/**
 * Completion donut — the RN port of the desktop project-overview ProgressRing
 * (an SVG arc via strokeDasharray/offset). Shows `percent`% in the centre with
 * an optional caption underneath (e.g. "3 / 8 done").
 *
 * `variant="instrument"` adds the knurled-meter look from the desktop Instrument
 * card (thicker track + centered % + 8 subtle ticks on the linear meter). The
 * default `variant` is the old simple ring for backward-compat call sites.
 *
 * The arc sweeps from 0 on first mount and from its previous value afterwards; the percent
 * label rolls with it. Reduce motion sets both instantly.
 */
export function ProgressRing({
  percent,
  size = 74,
  stroke = 5,
  caption,
  variant = "default",
}: {
  percent: number;
  size?: number;
  stroke?: number;
  caption?: string;
  variant?: "default" | "instrument";
}) {
  const t = useTheme();
  const instrument = variant === "instrument";
  const radius = instrument ? (size - stroke) / 2 - 8.5 : (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percent));
  const center = size / 2;

  const motion = useMotion();
  const progress = useSharedValue(motion.reduced ? clamped : 0);
  useEffect(() => {
    progress.set(motion.reduced ? clamped : withTiming(clamped, { duration: SWEEP_MS, easing: Easing.out(Easing.cubic) }));
  }, [clamped, motion.reduced, progress]);
  const arcProps = useAnimatedProps(() => ({ strokeDashoffset: circumference - (progress.get() / 100) * circumference }));

  const outerShadow = instrument
    ? { shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.22, shadowRadius: 10, elevation: 4 }
    : { shadowColor: "transparent", shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0, shadowRadius: 0, elevation: 0 };

  return (
    <View style={styles.wrap}>
      <View style={{ width: size, height: size, borderRadius: size / 2, ...outerShadow }}>
        <View
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: instrument ? 1 : 0,
            borderColor: instrument ? t.border : "transparent",
            backgroundColor: instrument ? t.surface2 : "transparent",
            alignItems: "center",
            justifyContent: "center",
            overflow: instrument ? "hidden" : "visible",
          }}
        >
        {instrument ? (
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              {
                borderRadius: size / 2,
                backgroundColor: t.surface3,
                opacity: 0.35,
                // Simulate radial highlight at 30% 30%
                transform: [{ translateX: -size * 0.15 }, { translateY: -size * 0.15 }],
              },
            ]}
          />
        ) : null}
        <Svg width={size} height={size}>
          <Circle cx={center} cy={center} r={radius} stroke={t.surface3} strokeWidth={stroke} fill="none" />
          <AnimatedCircle
            cx={center}
            cy={center}
            r={radius}
            stroke={t.accent}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={circumference}
            animatedProps={arcProps}
            // Start the arc at 12 o'clock (SVG 0° is 3 o'clock). Add subtle glow via shadow on container, not SVG filter
            transform={`rotate(-90 ${center} ${center})`}
            opacity={0.98}
          />
        </Svg>
        <View style={styles.label}>
          <RollingText text={`${clamped}%`} style={{ ...(instrument ? typeScale.caption : typeScale.subtitle), color: t.textPrimary, fontWeight: "700" }} />
        </View>
        </View>
      </View>
      {caption ? <Text style={[typeScale.micro, { color: t.textTertiary, marginTop: 4 }]}>{caption}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center" },
  label: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
});
