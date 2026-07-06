import { View, Text, StyleSheet } from "react-native";
import { useTheme, withAlpha, type Theme } from "@/theme";
import type { TagRow } from "@/db/queries";

/**
 * Tag pills matching the desktop tag chips — a coloured dot + name on a tinted
 * background derived from the tag colour. Renders nothing when there are no tags.
 */
export function TagChips({ tags, size = "md" }: { tags: TagRow[]; size?: "sm" | "md" }) {
  const t = useTheme();
  if (!tags.length) return null;
  const styles = makeStyles(t);
  const small = size === "sm";
  return (
    <View style={styles.row}>
      {tags.map((tag) => (
        <View
          key={tag.id}
          style={[
            styles.chip,
            small && styles.chipSm,
            { backgroundColor: withAlpha(tag.color, 0.14), borderColor: withAlpha(tag.color, 0.35) },
          ]}
        >
          <View style={[styles.dot, small && styles.dotSm, { backgroundColor: tag.color }]} />
          <Text style={[styles.text, small && styles.textSm, { color: t.textSecondary }]} numberOfLines={1}>
            {tag.name}
          </Text>
        </View>
      ))}
    </View>
  );
}

function makeStyles(_t: Theme) {
  return StyleSheet.create({
    row: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    chip: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 14, borderWidth: 1 },
    chipSm: { paddingVertical: 2, paddingHorizontal: 8, borderRadius: 10, gap: 4 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    dotSm: { width: 6, height: 6, borderRadius: 3 },
    text: { fontSize: 13, fontWeight: "600" },
    textSm: { fontSize: 11 },
  });
}
