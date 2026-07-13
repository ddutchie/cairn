import { View, Text, StyleSheet } from "react-native";
import { PressableScale } from "@/components/PressableScale";
import { useTheme, elevation, type as typeScale } from "@/theme";

/**
 * A tappable result card — a title line with an optional 1-line preview, an
 * optional right-aligned percentage score (tabular-nums), and an optional
 * leading colour dot (e.g. task priority). Shared by the Search tab's three
 * result lists (semantic / notes / tasks) and the note detail "Related notes"
 * list, which all rendered the same surface+border card with these pieces.
 */
export function ResultRow({
  title,
  preview,
  score,
  dotColor,
  accentColor,
  onPress,
}: {
  title: string;
  /** Optional secondary line (section title, note/task preview). */
  preview?: string | null;
  /** 0–1 similarity; rendered as a right-aligned whole-percent when provided. */
  score?: number;
  /** Optional leading dot colour (task priority). */
  dotColor?: string;
  /** Optional left edge-strip colour — used to distinguish result kinds
   *  (e.g. notes vs tasks) using the same tokens as the knowledge graph. */
  accentColor?: string;
  onPress: () => void;
}) {
  const t = useTheme();
  const hasHeaderRow = score != null || dotColor != null;
  const titleText = (
    <Text style={[styles.title, { color: t.textPrimary }]} numberOfLines={1}>
      {title || "Untitled"}
    </Text>
  );

  return (
    <PressableScale
      style={[
        styles.row,
        { backgroundColor: t.surface, borderColor: t.border },
        accentColor != null && { borderLeftColor: accentColor, borderLeftWidth: 3 },
        elevation.sm,
      ]}
      onPress={onPress}
    >
      {hasHeaderRow ? (
        <View style={styles.headerRow}>
          {dotColor != null && <View style={[styles.dot, { backgroundColor: dotColor }]} />}
          {titleText}
          {score != null && (
            <Text style={[styles.score, { color: t.textTertiary }]}>{Math.round(score * 100)}%</Text>
          )}
        </View>
      ) : (
        titleText
      )}
      {preview ? (
        <Text style={[styles.preview, { color: t.textSecondary }]} numberOfLines={1}>
          {preview}
        </Text>
      ) : null}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 10, paddingHorizontal: 14, marginBottom: 8, borderRadius: 10, borderWidth: 1 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  title: { ...typeScale.control, flexShrink: 1 },
  preview: { ...typeScale.caption, marginTop: 2 },
  score: { ...typeScale.caption, marginLeft: "auto", fontVariant: ["tabular-nums"] },
});
