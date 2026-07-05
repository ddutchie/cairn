import { useCallback, useState } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, RefreshControl } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { listNotes, type NoteRow } from "@/db/queries";
import { Screen } from "@/components/Screen";

export default function NotesScreen() {
  const router = useRouter();
  const [notes, setNotes] = useState<NoteRow[]>([]);

  const load = useCallback(() => {
    setNotes(listNotes());
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (notes.length === 0) {
    return (
      <Screen title="Notes">
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No notes yet</Text>
          <Text style={styles.emptyHint}>Import a desktop oplog from the Sync tab to pull your workspace.</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen title="Notes">
      <FlatList
        data={notes}
        keyExtractor={(n) => n.id}
        refreshControl={<RefreshControl refreshing={false} onRefresh={load} />}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => router.push(`/note/${item.id}`)}>
            <Text style={styles.title} numberOfLines={1}>
              {item.title || "Untitled"}
            </Text>
            {item.folder ? <Text style={styles.folder}>{item.folder}</Text> : null}
            <Text style={styles.preview} numberOfLines={2}>
              {(item.content ?? "").replace(/[#*_`>-]/g, "").trim()}
            </Text>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { padding: 12 },
  row: { paddingVertical: 12, paddingHorizontal: 14, marginBottom: 8, backgroundColor: "#fff", borderRadius: 10, borderWidth: 1, borderColor: "#eee" },
  title: { fontSize: 16, fontWeight: "600", color: "#111" },
  folder: { fontSize: 12, color: "#8b5cf6", marginTop: 2 },
  preview: { fontSize: 13, color: "#666", marginTop: 4 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  emptyTitle: { fontSize: 17, fontWeight: "600", color: "#333" },
  emptyHint: { fontSize: 13, color: "#888", textAlign: "center", marginTop: 8 },
});
