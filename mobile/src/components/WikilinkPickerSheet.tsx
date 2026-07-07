import { useMemo, useRef, useState } from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  TextInput,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { FileText, Search } from "lucide-react-native";
import { listNotes, searchNotes, type NoteRow } from "@/db/queries";
import { useTheme, elevation, withAlpha, type Theme } from "@/theme";

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
  const inputRef = useRef<TextInput>(null);

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
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
      onShow={() => inputRef.current?.focus()}
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Pressable style={styles.backdrop} onPress={onClose}>
          <Pressable style={[styles.sheet, elevation.xl]} onPress={() => {}}>
            <View style={styles.grabber} />
            <View style={styles.header}>
              <Pressable onPress={onClose} hitSlop={12}>
                <Text style={styles.cancel}>Cancel</Text>
              </Pressable>
              <Text style={styles.title}>Link a note</Text>
              <View style={{ width: 48 }} />
            </View>

            <View style={styles.searchRow}>
              <Search size={15} color={t.textTertiary} />
              <TextInput
                ref={inputRef}
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
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    flex: { flex: 1 },
    backdrop: { flex: 1, backgroundColor: withAlpha("#000000", 0.4), justifyContent: "flex-end" },
    sheet: {
      maxHeight: "70%",
      backgroundColor: t.surface,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      paddingBottom: 34,
    },
    grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: t.border, marginTop: 8 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 18,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    title: { fontSize: 16, fontWeight: "700", color: t.textPrimary },
    cancel: { fontSize: 16, color: t.textTertiary },
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
    searchInput: { flex: 1, color: t.textPrimary, fontSize: 15, padding: 0 },
    list: { paddingHorizontal: 10 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 12,
      paddingHorizontal: 12,
      borderRadius: 10,
    },
    name: { flex: 1, fontSize: 15, color: t.textPrimary },
    empty: { color: t.textTertiary, textAlign: "center", padding: 28, fontSize: 14 },
  });
}
