import { useMemo, useState } from "react";
import { Text, TextInput, FlatList, Pressable, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { searchNotes, type NoteRow } from "@/db/queries";
import { Screen } from "@/components/Screen";
import { GlassBar, glassActive } from "@/components/GlassBar";
import { useTheme, type Theme } from "@/theme";

export default function SearchScreen() {
  const router = useRouter();
  const t = useTheme();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NoteRow[]>([]);
  const styles = useMemo(() => makeStyles(t), [t]);

  const onChange = (text: string) => {
    setQuery(text);
    setResults(text.trim().length > 0 ? searchNotes(text.trim()) : []);
  };

  return (
    <Screen title="Search">
      <GlassBar style={styles.inputGlass} interactive={false}>
        <TextInput
          style={styles.input}
          placeholder="Search notes…"
          placeholderTextColor={t.textTertiary}
          value={query}
          onChangeText={onChange}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </GlassBar>
      <FlatList
        data={results}
        keyExtractor={(n) => n.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={query.trim().length > 0 ? <Text style={styles.hint}>No matches</Text> : null}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => router.push(`/note/${item.id}`)}>
            <Text style={styles.title} numberOfLines={1}>
              {item.title || "Untitled"}
            </Text>
            <Text style={styles.preview} numberOfLines={1}>
              {(item.content ?? "").replace(/[#*_`>[\]()!-]/g, "").trim()}
            </Text>
          </Pressable>
        )}
      />
    </Screen>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    inputGlass: {
      margin: 12,
      borderRadius: 12,
      overflow: "hidden",
      backgroundColor: glassActive ? undefined : t.surface,
      borderWidth: glassActive ? 0 : 1,
      borderColor: t.border,
    },
    input: {
      paddingHorizontal: 14,
      paddingVertical: 11,
      fontSize: 15,
      color: t.textPrimary,
    },
    list: { paddingHorizontal: 12 },
    row: { paddingVertical: 10, paddingHorizontal: 14, marginBottom: 8, backgroundColor: t.surface, borderRadius: 10, borderWidth: 1, borderColor: t.border },
    title: { fontSize: 15, fontWeight: "600", color: t.textPrimary },
    preview: { fontSize: 13, color: t.textSecondary, marginTop: 2 },
    hint: { textAlign: "center", color: t.textTertiary, marginTop: 24 },
  });
}
