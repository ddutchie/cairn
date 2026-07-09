import { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { useTheme, type as typeScale } from "@/theme";

/**
 * Context-window usage ring — the mobile analogue of the desktop ContextRing
 * (src/components/agent/ContextRing.tsx). An SVG donut whose arc fills with the
 * fraction of the model's context window currently used by the transcript.
 *
 * Threshold colours match desktop: accent <=65%, warning 65–85%, danger >85%.
 * Driven by the Apple provider's per-turn usage (session token count over the
 * model contextSize); hidden when usage is unavailable (other providers).
 */
export function ContextRing({
  promptTokens,
  contextLimit,
  size = 20,
  stroke = 2.5,
}: {
  promptTokens: number;
  contextLimit: number;
  size?: number;
  stroke?: number;
}) {
  const t = useTheme();

  const { pct, colour, r, circ, dash } = useMemo(() => {
    const p = contextLimit > 0 ? Math.min(promptTokens / contextLimit, 1) : 0;
    const radius = (size - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    return {
      pct: p,
      r: radius,
      circ: circumference,
      dash: p * circumference,
      colour: p > 0.85 ? t.danger : p > 0.65 ? t.warning : t.accent,
    };
  }, [promptTokens, contextLimit, size, stroke, t]);

  const pctLabel = `${Math.round(pct * 100)}%`;
  const half = size / 2;

  return (
    <View
      style={styles.wrap}
      accessibilityLabel={`Context ${pctLabel} used, ${promptTokens} of ${contextLimit} tokens`}
    >
      <Svg width={size} height={size}>
        {/* -90° rotation so the arc starts at 12 o'clock, like desktop. */}
        <Circle cx={half} cy={half} r={r} fill="none" stroke={t.border} strokeWidth={stroke} />
        <Circle
          cx={half}
          cy={half}
          r={r}
          fill="none"
          stroke={colour}
          strokeWidth={stroke}
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${half} ${half})`}
        />
      </Svg>
      <Text style={[styles.label, { color: t.textTertiary }]}>{pctLabel}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  label: { ...typeScale.caption, fontVariant: ["tabular-nums"] },
});
