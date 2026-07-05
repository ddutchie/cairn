import { useState } from "react";
import { Text, TextInput, FlatList, Pressable, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { searchNotes, type NoteRow } from "@/db/queries";
import { Screen } from "@/components/Screen";

export default function SearchScreen() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NoteRow[]>([]);

  const onChange = (text: string) => {
    setQuery(text);
    setResults(text.trim().length > 0 ? searchNotes(text.trim()) : []);
  };

  return (
    <Screen title="Search">
      <TextInput
        style={styles.input}
        placeholder="Search notes…"
        value={query}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
      />
      <FlatList
        data={results}
        keyExtractor={(n) => n.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          query.trim().length > 0 ? <Text style={styles.hint}>No matches</Text> : null
        }
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => router.push(`/note/${item.id}`)}>
            <Text style={styles.title} numberOfLines={1}>{item.title || "Untitled"}</Text>
            <Text style={styles.preview} numberOfLines={1}>
              {(item.content ?? "").replace(/[#*_`>-]/g, "").trim()}
            </Text>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: { margin: 12, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: "#fff", borderRadius: 10, borderWidth: 1, borderColor: "#e5e5e5", fontSize: 15 },
  list: { paddingHorizontal: 12 },
  row: { paddingVertical: 10, paddingHorizontal: 14, marginBottom: 8, backgroundColor: "#fff", borderRadius: 10, borderWidth: 1, borderColor: "#eee" },
  title: { fontSize: 15, fontWeight: "600", color: "#111" },
  preview: { fontSize: 13, color: "#666", marginTop: 2 },
  hint: { textAlign: "center", color: "#aaa", marginTop: 24 },
});
