import { View, Text, StyleSheet, Platform } from "react-native";
import { ProjectIcon } from "@/components/ProjectIcon";
import { useTheme, elevation } from "@/theme";
import type { ProjectSummary } from "./project-summary";
import { MiniRadar } from "./HealthRadar";

// Desktop's --font-display ("New York", then "Iowan Old Style") for the
// bottleneck line; React Native reaches the latter by name.
const DISPLAY_FONT = Platform.select({ ios: "Iowan Old Style", default: undefined });

/**
 * The open project at a glance — RN port of desktop's sidebar project card:
 * name, description, progress, "done / total · % · open", the bottleneck in
 * display italic, and the health radar's shape.
 */
export function ProjectCard({
  name,
  icon,
  description,
  summary,
}: {
  name: string;
  icon?: string | null;
  description?: string | null;
  summary: ProjectSummary;
}) {
  const t = useTheme();
  const { metrics, bottleneck, radarAxes } = summary;
  const total = metrics.allCards.length;
  const done = metrics.doneCards.length;
  const pct = metrics.completionRate;
  const open = metrics.openCards.length;
  return (
    <View style={[styles.card, { backgroundColor: t.surface2, borderColor: t.border }, elevation.sm]}>
      <View style={styles.titleRow}>
        <ProjectIcon name={icon} size={16} color={t.accent} />
        <Text style={[styles.name, { color: t.textPrimary }]} numberOfLines={1}>
          {name}
        </Text>
      </View>
      <Text style={[styles.description, { color: t.textTertiary }]} numberOfLines={1}>
        {description?.trim() || "No description"}
      </Text>
      <View style={styles.body}>
        <View style={{ flex: 1, minWidth: 0 }}>
          {total === 0 ? (
            <Text style={[styles.meta, { color: t.textTertiary }]}>No tasks yet</Text>
          ) : (
            <>
              <View style={[styles.track, { backgroundColor: t.surface3 }]}>
                <View style={[styles.fill, { width: `${pct}%`, backgroundColor: t.accent }]} />
              </View>
              <Text style={[styles.meta, { color: t.textTertiary }]} numberOfLines={1}>
                <Text style={[styles.count, { color: t.textPrimary }]}>{`${done} / ${total}`}</Text>
                {` · ${pct}% · ${open} open`}
              </Text>
              {bottleneck ? (
                <Text style={[styles.bottleneck, { color: t.accent }]} numberOfLines={1}>
                  {`${bottleneck.name.toLowerCase()} holds ${bottleneck.count}`}
                </Text>
              ) : null}
            </>
          )}
        </View>
        <MiniRadar axes={radarAxes} size={48} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 14, padding: 12 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { flex: 1, fontSize: 15, fontWeight: "600" },
  description: { fontSize: 13, marginTop: 4 },
  body: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 10 },
  track: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 3 },
  meta: { fontSize: 12, marginTop: 6 },
  count: { fontFamily: "Menlo", fontWeight: "700" },
  bottleneck: { fontSize: 13, fontStyle: "italic", marginTop: 4, fontFamily: DISPLAY_FONT },
});
