import { useEffect } from "react";
import { View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import type { WorkPhase } from "@cairn/shared/conversation/work-phase";
import { useTheme, withAlpha } from "@/theme";
import { useMotion, useScreenActive } from "@/lib/use-motion";

type Shape = "arc" | "dots" | "orbit" | "pulse";

/**
 * One shape per phase; phases share shapes where the meaning is close. Waiting on the model and
 * generic work spin an arc, reasoning breathes dots, a tool orbits, writing the answer pulses.
 */
const SHAPE: Record<WorkPhase, Shape> = {
  sending: "arc",
  thinking: "dots",
  responding: "pulse",
  tools: "orbit",
  working: "arc",
  retrying: "orbit",
  compacting: "pulse",
  waiting: "dots",
};

/** Loop length per shape, ms. Calm phases are slower so "waiting on you" never looks urgent. */
const PERIOD: Record<WorkPhase, number> = {
  sending: 900,
  thinking: 1400,
  responding: 1500,
  tools: 1100,
  working: 1000,
  retrying: 700,
  compacting: 1800,
  waiting: 2200,
};

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * Activity indicator for a chat turn in flight: SVG drawn on the UI thread by Reanimated, tinted
 * with the accent. It replaces a per-message WebView, so it appears instantly and several can sit
 * in a long chat without each costing a web engine. Reduce motion draws a still frame; the loop
 * also stops while the screen is blurred.
 */
export function WorkLoader({ phase, size = 20 }: { phase: WorkPhase; size?: number }) {
  const t = useTheme();
  const motion = useMotion();
  const active = useScreenActive();
  const clock = useSharedValue(0);
  const period = PERIOD[phase];
  const running = active && !motion.reduced;

  useEffect(() => {
    if (!running) {
      cancelAnimation(clock);
      clock.set(0.25);
      return;
    }
    clock.set(0);
    clock.set(withRepeat(withTiming(1, { duration: period, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(clock);
  }, [running, period, clock]);

  const shape = SHAPE[phase];
  return (
    <View style={{ width: size, height: size }} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {shape === "arc" ? <ArcLoader size={size} color={t.accent} clock={clock} /> : null}
      {shape === "dots" ? <DotsLoader size={size} color={t.accent} clock={clock} /> : null}
      {shape === "orbit" ? <OrbitLoader size={size} color={t.accent} clock={clock} /> : null}
      {shape === "pulse" ? <PulseLoader size={size} color={t.accent} clock={clock} /> : null}
    </View>
  );
}

interface LoaderProps {
  size: number;
  color: string;
  clock: SharedValue<number>;
}

/** A quarter-circle arc turning around a faint track. */
function ArcLoader({ size, color, clock }: LoaderProps) {
  const stroke = Math.max(2, size * 0.12);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${clock.get() * 360}deg` }] }));
  return (
    <Animated.View style={[{ width: size, height: size }, spin]}>
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={withAlpha(color, 0.2)} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c * 0.28} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
    </Animated.View>
  );
}

/** Three dots rising and falling in a travelling wave. */
function DotsLoader({ size, color, clock }: LoaderProps) {
  const base = size * 0.11;
  const gap = size * 0.3;
  return (
    <Svg width={size} height={size}>
      {[0, 1, 2].map((i) => (
        <WaveDot key={i} cx={size / 2 + (i - 1) * gap} cy={size / 2} base={base} color={color} clock={clock} index={i} />
      ))}
    </Svg>
  );
}

function WaveDot({ cx, cy, base, color, clock, index }: { cx: number; cy: number; base: number; color: string; clock: SharedValue<number>; index: number }) {
  const props = useAnimatedProps(() => {
    const wave = 0.5 + 0.5 * Math.sin((clock.get() - index * 0.16) * 2 * Math.PI);
    return { r: base * (0.65 + 0.55 * wave), opacity: 0.3 + 0.7 * wave };
  });
  return <AnimatedCircle cx={cx} cy={cy} fill={color} animatedProps={props} />;
}

/** Three dots circling the centre with a fading tail. */
function OrbitLoader({ size, color, clock }: LoaderProps) {
  const dot = size * 0.1;
  const orbit = size / 2 - dot - 0.5;
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${clock.get() * 360}deg` }] }));
  return (
    <Animated.View style={[{ width: size, height: size }, spin]}>
      <Svg width={size} height={size}>
        {[0, 1, 2].map((i) => {
          const a = -Math.PI / 2 - i * 0.55;
          return <Circle key={i} cx={size / 2 + Math.cos(a) * orbit} cy={size / 2 + Math.sin(a) * orbit} r={dot * (1 - i * 0.18)} fill={color} opacity={1 - i * 0.32} />;
        })}
      </Svg>
    </Animated.View>
  );
}

/** A ring that swells outward and fades, around a steady core. */
function PulseLoader({ size, color, clock }: LoaderProps) {
  const core = size * 0.14;
  const max = size / 2 - 1;
  const ring = useAnimatedProps(() => {
    const p = clock.get();
    return { r: core + (max - core) * p, opacity: 1 - p };
  });
  return (
    <Svg width={size} height={size}>
      <AnimatedCircle cx={size / 2} cy={size / 2} fill="none" stroke={color} strokeWidth={Math.max(1.5, size * 0.08)} animatedProps={ring} />
      <Circle cx={size / 2} cy={size / 2} r={core} fill={color} />
    </Svg>
  );
}
