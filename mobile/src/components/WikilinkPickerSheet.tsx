import { useMemo, useState } from "react";
import { View, Text, Pressable, TextInput, FlatList, StyleSheet } from "react-native";
import { FileText, Search } from "lucide-react-native";
import { listNotes, searchNotes, type NoteRow } from "@/db/queries";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { BottomSheet, BottomSheetHeader } from "./BottomSheet";

/**
 * Bottom-anchored note picker for inserting a `[[Wikilink]]`. Searches note
 * titles/content; picking a note returns its title so the caller can insert
 * `[[Title]]` at the cursor. Mirrors the desktop wikilink picker.
 */
export function WikilinkPickerSheet({
  visible,
  onSelect,
  onClose,
}: {
  visible: boolean;
  onSelect: (title: string) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [query, setQuery] = useState("");

  // Reset the query each time the sheet opens.
  const [wasVisible, setWasVisible] = useState(false);
  if (visible && !wasVisible) {
    setQuery("");
    setWasVisible(true);
  } else if (!visible && wasVisible) {
    setWasVisible(false);
  }

  const results: NoteRow[] = useMemo(() => {
    if (!visible) return [];
    const rows = query.trim() ? searchNotes(query.trim()) : listNotes();
    return rows.slice(0, 50);
  }, [visible, query]);

  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeight="70%" avoidKeyboard>
      <BottomSheetHeader title="Link a note" onCancel={onClose} />

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

      {results.length === 0 ? (
        <Text style={styles.empty}>No notes found.</Text>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(n) => n.id}
          keyboardShouldPersistTaps="handled"
          style={styles.list}
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => onSelect(item.title || "Untitled")}>
              <FileText size={15} color={t.textTertiary} />
              <Text style={styles.name} numberOfLines={1}>
                {item.title || "Untitled"}
              </Text>
            </Pressable>
          )}
        />
      )}
    </BottomSheet>
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
