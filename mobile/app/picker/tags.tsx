import { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, FlatList, StyleSheet } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Check } from "lucide-react-native";
import { listAllTags, type TagRow } from "@/db/queries";
import { useTheme, withAlpha, type as typeScale, type Theme } from "@/theme";
import { resolveSheetResult, discardSheetResult } from "@/lib/sheet-result";

/**
 * Native formSheet route for selecting a note/card's tags. Presents every
 * workspace tag as a toggleable row (coloured dot + name + check). Selection is
 * held locally and returned via the result key on Done, so the caller can
 * persist it in one write (setNoteTags / setCardTags).
 */
export default function TagPickerRoute() {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();
  const { resultKey, initial } = useLocalSearchParams<{ resultKey?: string; initial?: string }>();

  const initialIds = useMemo<string[]>(() => {
    try {
      const v = initial ? JSON.parse(initial) : [];
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  }, [initial]);

  const allTags: TagRow[] = useMemo(() => listAllTags(), []);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialIds));

  // Dismissed without Done (swipe-down)? Drop the caller's pending handler so
  // it isn't left registered after this route unmounts.
  useEffect(() => {
    return () => {
      if (resultKey) discardSheetResult(resultKey);
    };
  }, [resultKey]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const done = () => {
    if (resultKey) resolveSheetResult(resultKey, [...selected]);
    router.back();
  };

  return (
    <>
      <Stack.Screen options={{ title: "Tags" }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button accessibilityLabel="Cancel" onPress={() => router.back()}>
          Cancel
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button accessibilityLabel="Done" onPress={done}>
          Done
        </Stack.Toolbar.Button>
      </Stack.Toolbar>

      {allTags.length === 0 ? (
        <Text style={styles.empty}>No tags in this workspace yet.</Text>
      ) : (
        <FlatList
          data={allTags}
          keyExtractor={(tag) => tag.id}
          style={[styles.list, { flex: 1 }]}
          contentInsetAdjustmentBehavior="automatic"
          renderItem={({ item }) => {
            const on = selected.has(item.id);
            return (
              <Pressable
                style={[styles.row, on && { backgroundColor: withAlpha(item.color, 0.1) }]}
                onPress={() => toggle(item.id)}
              >
                <View style={[styles.dot, { backgroundColor: item.color }]} />
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                {on && <Check size={18} color={t.accent} />}
              </Pressable>
            );
          }}
        />
      )}
    </>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    list: { paddingHorizontal: 10 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 12,
      borderRadius: 10,
    },
    dot: { width: 12, height: 12, borderRadius: 6 },
    name: { flex: 1, ...typeScale.body, color: t.textPrimary },
    empty: { color: t.textTertiary, textAlign: "center", padding: 28, ...typeScale.caption },
  });
}
