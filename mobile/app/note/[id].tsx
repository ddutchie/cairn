import { useLocalSearchParams, Stack } from "expo-router";
import { ScrollView, Text, StyleSheet, View } from "react-native";
import { getNote } from "@/db/queries";

export default function NoteDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const note = id ? getNote(id) : null;

  if (!note) {
    return (
      <View style={styles.center}>
        <Text style={styles.missing}>Note not found</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: note.title || "Note" }} />
      <Text style={styles.title}>{note.title || "Untitled"}</Text>
      {note.folder ? <Text style={styles.folder}>{note.folder}</Text> : null}
      <Text style={styles.body}>{note.content ?? ""}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 18 },
  title: { fontSize: 22, fontWeight: "700", color: "#111" },
  folder: { fontSize: 12, color: "#8b5cf6", marginTop: 4 },
  // Read-only markdown source for the P3 MVP; a proper markdown renderer lands later.
  body: { fontSize: 15, lineHeight: 22, color: "#222", marginTop: 16, fontFamily: "Menlo" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  missing: { color: "#888" },
});
