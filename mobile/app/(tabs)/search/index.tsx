import { useCallback, useMemo, useRef, useState } from "react";
import { Text, FlatList, StyleSheet } from "react-native";
import { Stack, useRouter, useFocusEffect } from "expo-router";
import type { SearchBarCommands } from "react-native-screens";
import { searchNotes, type NoteRow } from "@/db/queries";
import { PressableScale } from "@/components/PressableScale";
import { TabScreen } from "@/components/TabScreen";
import { stripMarkdown } from "@cairn/shared/notes/text";
import { useTheme, elevation, type Theme } from "@/theme";

/**
 * Search screen using the native iOS search bar (headerSearchBarOptions) — the
 * platform UISearchController integrated into the large-title header, instead
 * of a hand-rolled text field. Query text arrives via onChangeText on the
 * native bar; results render in a themed list below.
 */
export default function SearchScreen() {
  const router = useRouter();
  const t = useTheme();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NoteRow[]>([]);
  const styles = useMemo(() => makeStyles(t), [t]);
  const searchRef = useRef<SearchBarCommands>(null);

  const onChange = (text: string) => {
    setQuery(text);
    setResults(text.trim().length > 0 ? searchNotes(text.trim()) : []);
  };

  // Focus the native search bar (and raise the keyboard) every time the tab is
  // opened — not just on first mount, since native tabs stay mounted. A short
  // delay lets the header search controller finish presenting first.
  useFocusEffect(
    useCallback(() => {
      const id = setTimeout(() => searchRef.current?.focus(), 350);
      return () => clearTimeout(id);
    }, []),
  );

  return (
    <TabScreen>
      <Stack.Screen
        options={{
          title: "Search",
          headerSearchBarOptions: {
            ref: searchRef,
            placeholder: "Search notes",
            autoCapitalize: "none",
            autoFocus: true,
            hideWhenScrolling: false,
            onChangeText: (e) => onChange(e.nativeEvent.text),
          },
        }}
      />
      <FlatList
        data={results}
        keyExtractor={(n) => n.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        ListEmptyComponent={
          query.trim().length > 0 ? <Text style={styles.hint}>No matches</Text> : null
        }
        renderItem={({ item }) => (
          <PressableScale
            style={[styles.row, elevation.sm]}
            onPress={() => router.push(`/note/${item.id}`)}
          >
            <Text style={styles.title} numberOfLines={1}>
              {item.title || "Untitled"}
            </Text>
            <Text style={styles.preview} numberOfLines={1}>
              {stripMarkdown(item.content ?? "")}
            </Text>
          </PressableScale>
        )}
      />
    </TabScreen>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    list: { padding: 12 },
    row: {
      paddingVertical: 10,
      paddingHorizontal: 14,
      marginBottom: 8,
      backgroundColor: t.surface,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border,
    },
    title: { fontSize: 15, fontWeight: "600", color: t.textPrimary },
    preview: { fontSize: 13, color: t.textSecondary, marginTop: 2 },
    hint: { textAlign: "center", color: t.textTertiary, marginTop: 24 },
  });
}
