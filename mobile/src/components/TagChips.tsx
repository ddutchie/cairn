import { View, Text, StyleSheet } from "react-native";
import { useTheme, withAlpha, type as typeScale } from "@/theme";
import type { TagRow } from "@/db/queries";

/**
 * Tag pills matching the desktop tag chips — a coloured dot + name on a tinted
 * background derived from the tag colour. Renders nothing when there are no tags.
 * Pass `max` to cap the row; any tags beyond the cap collapse into a "+N" chip.
 */
export function TagChips({ tags, size = "md", max }: { tags: TagRow[]; size?: "sm" | "md"; max?: number }) {
  const t = useTheme();
  if (!tags.length) return null;
  const small = size === "sm";
  const cap = typeof max === "number" && Number.isFinite(max) ? Math.max(0, Math.floor(max)) : Infinity;
  const capped = tags.length > cap;
  const shown = capped ? tags.slice(0, cap) : tags;
  const overflow = capped ? tags.length - cap : 0;
  return (
    <View style={styles.row}>
      {shown.map((tag) => (
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
      {overflow > 0 && (
        <View
          style={[
            styles.chip,
            small && styles.chipSm,
            styles.overflowChip,
            { borderColor: withAlpha(t.border, 1) },
          ]}
        >
          <Text style={[styles.text, small && styles.textSm, { color: t.textTertiary }]}>+{overflow}</Text>
        </View>
      )}
    </View>
  );
}

// Colours here are all applied inline (per-tag), so the sheet has no
// theme-dependent values — hoist it to module scope instead of rebuilding a
// StyleSheet on every render (TagChips renders once per note/card/calendar row).
const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 14, borderWidth: 1 },
  chipSm: { paddingVertical: 2, paddingHorizontal: 8, borderRadius: 10, gap: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotSm: { width: 6, height: 6, borderRadius: 3 },
  text: { ...typeScale.label },
  textSm: { fontSize: 11 },
  overflowChip: { backgroundColor: "transparent" },
});
