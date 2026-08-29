import { View, Text, StyleSheet } from "react-native";
import Svg, { Polygon, Line, Circle, Text as SvgText } from "react-native-svg";
import { useTheme } from "@/theme";

export type RadarAxis = { key: string; label: string; short: string; value: number; color: string };

export function HealthRadar({ axes, size = 260 }: { axes: RadarAxis[]; size?: number }) {
  const t = useTheme();
  const n = axes.length;
  const cx = size / 2;
  const cy = size / 2;
  // 0.30 keeps right labels (Mome 49) inside 260 viewBox with 12px card padding — 0.38 clipped at 259+35=294
  const radius = size * 0.30;
  const levels = 4;

  const angleFor = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const pointFor = (value: number, i: number) => {
    const a = angleFor(i);
    const r = radius * Math.max(0, Math.min(1, value));
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as const;
  };

  const polygonPoints = axes.map((ax, i) => pointFor(ax.value, i).join(",")).join(" ");

  const rings = Array.from({ length: levels }, (_, li) => {
    const r = radius * ((li + 1) / levels);
    return axes
      .map((_, i) => {
        const a = angleFor(i);
        return `${cx + Math.cos(a) * r},${cy + Math.sin(a) * r}`;
      })
      .join(" ");
  });

  return (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
      <View style={styles.header}>
        <View style={[styles.iconBox, { backgroundColor: t.surface2, borderColor: t.border }]}>
          <Text style={[styles.iconGlyph, { color: t.textTertiary }]}>⬢</Text>
        </View>
        <Text style={[styles.title, { color: t.textPrimary }]}>Project health</Text>
        <Text style={[styles.subtitle, { color: t.textTertiary }]}>— 6-axis radar</Text>
        <Text style={[styles.scale, { color: t.textTertiary }]}>0 → 1</Text>
      </View>

      <View style={styles.body}>
        <View style={{ width: "100%", maxWidth: size, aspectRatio: 1, alignSelf: "center", overflow: "visible" }}>
          <Svg width="100%" height="100%" viewBox={`0 0 ${size} ${size}`} style={{ overflow: "visible" }}>
            {/* rings */}
            {rings.map((pts, i) => (
              <Polygon
                key={i}
                points={pts}
                fill="none"
                stroke={t.border}
                strokeWidth={i === levels - 1 ? 1.25 : 1}
                opacity={i === levels - 1 ? 0.9 : 0.5}
              />
            ))}
            {/* axes */}
            {axes.map((_, i) => {
              const a = angleFor(i);
              const x2 = cx + Math.cos(a) * radius;
              const y2 = cy + Math.sin(a) * radius;
              return <Line key={i} x1={cx} y1={cy} x2={x2} y2={y2} stroke={t.border} strokeWidth={1} opacity={0.7} />;
            })}
            {/* value polygon */}
            <Polygon
              points={polygonPoints}
              fill={t.accent}
              fillOpacity={0.18}
              stroke={t.accent}
              strokeWidth={2}
              strokeLinejoin="round"
            />
            {/* dots */}
            {axes.map((ax, i) => {
              const [x, y] = pointFor(ax.value, i);
              return <Circle key={ax.key} cx={x} cy={y} r={3.5} fill={t.accent} stroke={t.surface} strokeWidth={1.5} />;
            })}
            {/* labels — single text to avoid nested tspan offset issues in RN SVG */}
            {axes.map((ax, i) => {
              const a = angleFor(i);
              const r = radius + 14;
              const x = cx + Math.cos(a) * r;
              const y = cy + Math.sin(a) * r;
              const anchor = Math.cos(a) > 0.35 ? "start" : Math.cos(a) < -0.35 ? "end" : "middle";
              const dy = Math.sin(a) > 0.5 ? 4 : Math.sin(a) < -0.5 ? -6 : 3;
              return (
                <SvgText
                  key={ax.key}
                  x={x}
                  y={y + dy}
                  textAnchor={anchor}
                  fontSize={10}
                  fontWeight="600"
                  fill={t.textTertiary}
                >
                  {`${ax.short} ${Math.round(ax.value * 100)}`}
                </SvgText>
              );
            })}
            <Circle cx={cx} cy={cy} r={2} fill={t.textTertiary} opacity={0.6} />
          </Svg>
        </View>

        <View style={styles.legendGrid}>
          {axes.map((ax) => (
            <View key={ax.key} style={[styles.legendTile, { backgroundColor: t.surface2, borderColor: t.border }]}>
              <View style={styles.legendHead}>
                <View style={[styles.dot, { backgroundColor: ax.color }]} />
                <Text style={[styles.legendLabel, { color: t.textSecondary }]} numberOfLines={1}>
                  {ax.label}
                </Text>
              </View>
              <View style={[styles.legendTrack, { backgroundColor: t.surface3 }]}>
                <View style={[styles.legendFill, { width: `${Math.round(ax.value * 100)}%`, backgroundColor: ax.color }]} />
              </View>
              <Text style={[styles.legendPct, { color: t.textTertiary }]}>{Math.round(ax.value * 100)}%</Text>
            </View>
          ))}
        </View>
        <Text style={[styles.foot, { color: t.textTertiary }]}>
          Six balance axes from live project data — completion, momentum, focus, knowledge, flow, calm (inverse urgent load). 100 is healthiest.
        </Text>
      </View>
    </View>
  );
}

export function buildRadarAxes(metrics: {
  completionRate: number;
  openCards: { length: number };
  overdueCount: number;
  todayCount: number;
  notes: { length: number };
  pinnedNotes: { length: number };
  recentNotes: { length: number };
  bottleneck: { count: number } | null;
  priorityCounts: { urgent: number; high: number; medium: number; low: number };
  columns: { id: string; type: string }[];
  allCards: { length: number };
  activityByDay: { items: unknown[] }[];
}): RadarAxis[] {
  const open = Math.max(metrics.openCards.length, 1);
  const total = Math.max(metrics.allCards.length, 1);
  const need = metrics.overdueCount + metrics.todayCount;

  const completion = Math.max(0, Math.min(1, metrics.completionRate / 100));

  const recentRatio = metrics.notes.length ? metrics.recentNotes.length / Math.min(metrics.notes.length, 8) : 0;
  const doneRatio = (total - open) / total;
  const activityRatio = Math.min(metrics.activityByDay.length / 5, 1);
  const momentum = Math.max(0, Math.min(1, recentRatio * 0.35 + doneRatio * 0.4 + activityRatio * 0.25));

  const focus = Math.max(0, Math.min(1, 1 - need / open));

  const notesVol = Math.min(metrics.notes.length / 12, 1);
  const pinnedHealth = metrics.notes.length ? Math.min(metrics.pinnedNotes.length / 4, 1) * 0.6 + 0.4 : 0;
  const knowledge = Math.max(0, Math.min(1, notesVol * 0.7 + pinnedHealth * 0.3));

  const bottleneckCount = metrics.bottleneck?.count ?? 0;
  const flow = Math.max(0, Math.min(1, 1 - bottleneckCount / open));

  const urgentHigh = (metrics.priorityCounts.urgent ?? 0) + (metrics.priorityCounts.high ?? 0);
  const calm = Math.max(0, Math.min(1, 1 - urgentHigh / open));

  return [
    { key: "completion", label: "Completion", short: "Done", value: completion, color: "#3ecf8e" },
    { key: "momentum", label: "Momentum", short: "Mome", value: momentum, color: "#8faf6f" },
    { key: "focus", label: "Focus", short: "Focus", value: focus, color: "#60a5fa" },
    { key: "knowledge", label: "Knowledge", short: "Know", value: knowledge, color: "#a78bfa" },
    { key: "flow", label: "Flow", short: "Flow", value: flow, color: "#f59e0b" },
    { key: "calm", label: "Calm", short: "Calm", value: calm, color: "#3ecf8e" },
  ];
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 14, padding: 12 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  iconBox: { width: 20, height: 20, borderRadius: 6, alignItems: "center", justifyContent: "center", borderWidth: 1 },
  iconGlyph: { fontSize: 10, lineHeight: 12 },
  title: { fontSize: 13, fontWeight: "600", letterSpacing: -0.1 },
  subtitle: { fontSize: 12, fontWeight: "400" },
  scale: { marginLeft: "auto", fontSize: 10, fontFamily: "Menlo", fontWeight: "500" },
  body: { gap: 16 },
  legendGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  legendTile: { width: "48.2%", borderWidth: 1, borderRadius: 10, padding: 10 },
  legendHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  legendLabel: { fontSize: 11, fontWeight: "600", flex: 1 },
  legendTrack: { height: 6, borderRadius: 3, overflow: "hidden", marginTop: 8 },
  legendFill: { height: "100%", borderRadius: 3 },
  legendPct: { fontSize: 10, fontFamily: "Menlo", marginTop: 4 },
  foot: { fontSize: 11, lineHeight: 16, marginTop: 4 },
});
