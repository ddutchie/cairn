import { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, TextInput, FlatList, StyleSheet } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { FileText, Search } from "lucide-react-native";
import { listNotes, searchNotes, type NoteRow } from "@/db/queries";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { resolveSheetResult, discardSheetResult } from "@/lib/sheet-result";

/**
 * Native formSheet note picker for inserting a `[[Wikilink]]`. Searches note
 * titles/content; picking a note returns its title so the caller can insert
 * `[[Title]]` at the cursor. Mirrors the desktop wikilink picker.
 */
export default function WikilinkPickerRoute() {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();
  const { resultKey } = useLocalSearchParams<{ resultKey?: string }>();
  const [query, setQuery] = useState("");

  const results: NoteRow[] = useMemo(() => {
    const rows = query.trim() ? searchNotes(query.trim()) : listNotes();
    return rows.slice(0, 50);
  }, [query]);

  const pick = (title: string) => {
    if (resultKey) resolveSheetResult(resultKey, title);
    router.back();
  };

  // Dismissed without picking (swipe-down)? Drop the caller's pending handler.
  useEffect(() => {
    return () => {
      if (resultKey) discardSheetResult(resultKey);
    };
  }, [resultKey]);

  return (
    <>
      <Stack.Screen options={{ title: "Link a note" }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button accessibilityLabel="Cancel" onPress={() => router.back()}>
          Cancel
        </Stack.Toolbar.Button>
      </Stack.Toolbar>

      <FlatList
        data={results}
        keyExtractor={(n) => n.id}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        style={[styles.list, { flex: 1 }]}
        ListHeaderComponent={
          <View style={styles.searchRow}>
            <Search size={15} color={t.textTertiary} />
            <TextInput
              autoFocus
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Search notes…"
              placeholderTextColor={t.textTertiary}
              autoCorrect={false}
              returnKeyType="search"
            />
          </View>
        }
        ListEmptyComponent={<Text style={styles.empty}>No notes found.</Text>}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => pick(item.title || "Untitled")}>
            <FileText size={15} color={t.textTertiary} />
            <Text style={styles.name} numberOfLines={1}>
              {item.title || "Untitled"}
            </Text>
          </Pressable>
        )}
      />
    </>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    searchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginHorizontal: 14,
      marginVertical: 10,
      paddingHorizontal: 12,
      height: 40,
      backgroundColor: t.surface2,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border,
    },
    searchInput: { flex: 1, color: t.textPrimary, ...typeScale.body, padding: 0 },
    list: { paddingHorizontal: 10 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 12,
      paddingHorizontal: 12,
      borderRadius: 10,
    },
    name: { flex: 1, ...typeScale.body, color: t.textPrimary },
    empty: { color: t.textTertiary, textAlign: "center", padding: 28, ...typeScale.caption },
  });
}
