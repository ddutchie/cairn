import { useMemo } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { SearchField } from "@/components/SearchField";
import { useTheme, withAlpha, type as typeScale } from "@/theme";
import type { TagRow } from "@/db/queries";

/**
 * The notes-tab filter row: a text search field plus a horizontal row of
 * tag-filter chips (tap to toggle). Mirrors the desktop note filter.
 */
export function NoteFilterBar({
  filter,
  onFilter,
  tags,
  activeTagId,
  onToggleTag,
}: {
  filter: string;
  onFilter: (v: string) => void;
  tags: TagRow[];
  activeTagId: string | null;
  onToggleTag: (id: string) => void;
}) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(), []);
  return (
    <View style={styles.filterWrap}>
      <SearchField value={filter} onChangeText={onFilter} placeholder="Filter notes…" />
      {tags.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tagFilterRow} keyboardShouldPersistTaps="handled">
          {tags.map((tag) => {
            const active = activeTagId === tag.id;
            return (
              <Pressable
                key={tag.id}
                onPress={() => onToggleTag(tag.id)}
                style={[
                  styles.tagFilterChip,
                  {
                    backgroundColor: active ? tag.color : withAlpha(tag.color, 0.14),
                    borderColor: active ? tag.color : withAlpha(tag.color, 0.35),
                  },
                ]}
              >
                {!active && <View style={[styles.tagFilterDot, { backgroundColor: tag.color }]} />}
                <Text style={[styles.tagFilterText, { color: active ? t.accentFg : t.textSecondary }]} numberOfLines={1}>
                  {tag.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

function makeStyles() {
  return StyleSheet.create({
    filterWrap: { paddingHorizontal: 12, paddingBottom: 8, gap: 8 },
    tagFilterRow: { gap: 8, paddingRight: 12 },
    tagFilterChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 5, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1 },
    tagFilterDot: { width: 7, height: 7, borderRadius: 4 },
    tagFilterText: { ...typeScale.label, maxWidth: 140 },
  });
}
