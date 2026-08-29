import { View, Text, StyleSheet } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { useTheme, type as typeScale } from "@/theme";

/**
 * Completion donut — the RN port of the desktop project-overview ProgressRing
 * (an SVG arc via strokeDasharray/offset). Shows `percent`% in the centre with
 * an optional caption underneath (e.g. "3 / 8 done").
 *
 * `variant="instrument"` adds the knurled-meter look from the desktop Instrument
 * card (thicker track + centered % + 8 subtle ticks on the linear meter). The
 * default `variant` is the old simple ring for backward-compat call sites.
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
  // Desktop instrument uses r=26 for 74px — keep that exact for the knurled look, not (size-stroke)/2
  const radius = instrument ? 26 : (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percent));
  const offset = circumference - (clamped / 100) * circumference;
  const center = size / 2;

  return (
    <View style={styles.wrap}>
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
          // Desktop: radial-gradient(120px 80px at 30% 30%, var(--surface-3), var(--surface-2)) + inset highlight + drop shadow
          shadowColor: instrument ? "#000" : "transparent",
          shadowOffset: instrument ? { width: 0, height: 4 } : { width: 0, height: 0 },
          shadowOpacity: instrument ? 0.22 : 0,
          shadowRadius: instrument ? 10 : 0,
          elevation: instrument ? 4 : 0,
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
            // Start the arc at 12 o'clock (SVG 0° is 3 o'clock). Add subtle glow via shadow on container, not SVG filter
            transform={`rotate(-90 ${center} ${center})`}
            opacity={0.98}
          />
        </Svg>
        <View style={styles.label}>
          <Text style={[instrument ? typeScale.caption : typeScale.subtitle, { color: t.textPrimary, fontWeight: "700" }]}>{clamped}%</Text>
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
