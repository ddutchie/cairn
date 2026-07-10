import { View, Text, StyleSheet } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { useTheme, type as typeScale } from "@/theme";

/**
 * Completion donut — the RN port of the desktop project-overview ProgressRing
 * (an SVG arc via strokeDasharray/offset). Shows `percent`% in the centre with
 * an optional caption underneath (e.g. "3 / 8 done").
 */
export function ProgressRing({
  percent,
  size = 72,
  stroke = 7,
  caption,
}: {
  percent: number;
  size?: number;
  stroke?: number;
  caption?: string;
}) {
  const t = useTheme();
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percent));
  const offset = circumference - (clamped / 100) * circumference;
  const center = size / 2;

  return (
    <View style={styles.wrap}>
      <View style={{ width: size, height: size }}>
        <Svg width={size} height={size}>
          <Circle cx={center} cy={center} r={radius} stroke={t.surface3} strokeWidth={stroke} fill="none" />
          <Circle
            cx={center}
            cy={center}
            r={radius}
            stroke={t.accent}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            // Start the arc at 12 o'clock (SVG 0° is 3 o'clock).
            transform={`rotate(-90 ${center} ${center})`}
          />
        </Svg>
        <View style={styles.label}>
          <Text style={[typeScale.subtitle, { color: t.textPrimary }]}>{clamped}%</Text>
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
