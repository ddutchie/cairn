import { View, Text, ScrollView, RefreshControl, TextInput } from "react-native";
import { useRouter } from "expo-router";
import { useState, useCallback, useEffect } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { Search } from "lucide-react-native";
import { useStore } from "../../store/index";
import { NoteRow } from "../../components/NoteRow";

export default function NotesTab() {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");

  const activeProjectId = useStore((s) => s.activeProjectId);
  const notes = useStore((s) => s.notes);
  const projects = useStore((s) => s.projects);
  const loadNotes = useStore((s) => s.loadNotes);
  const activeProject = projects.find((p) => p.id === activeProjectId);

  useEffect(() => { if (activeProjectId) loadNotes(activeProjectId); }, [activeProjectId]);

  const onRefresh = useCallback(async () => {
    if (!activeProjectId) return;
    setRefreshing(true);
    await loadNotes(activeProjectId);
    setRefreshing(false);
  }, [activeProjectId]);

  const filtered = notes.filter(
    (n) => !query.trim() || n.title.toLowerCase().includes(query.toLowerCase()) || n.contentText.toLowerCase().includes(query.toLowerCase())
  );
  const pinned = filtered.filter((n) => n.isPinned);
  const rest = filtered.filter((n) => !n.isPinned);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#0d0d0d" }} edges={["top"]}>
      {/* Header */}
      <View style={{
        flexDirection: "row", alignItems: "center",
        paddingHorizontal: 16, paddingVertical: 10,
        borderBottomWidth: 1, borderBottomColor: "#2a2a2a",
      }}>
        <Text style={{ flex: 1, color: "#9e9a94", fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.8 }}>
          Notes
        </Text>
        {activeProject && (
          <Text style={{ color: "#3a3835", fontSize: 11 }}>{activeProject.name}</Text>
        )}
      </View>

      {/* Search */}
      <View style={{ marginHorizontal: 8, marginTop: 8, marginBottom: 6, flexDirection: "row", alignItems: "center", backgroundColor: "#141414", borderRadius: 8, borderWidth: 1, borderColor: "#2a2a2a", paddingHorizontal: 10, gap: 6 }}>
        <Search color="#66635f" size={14} />
        <TextInput
          style={{ flex: 1, color: "#e8e4dc", fontSize: 13, paddingVertical: 10 }}
          placeholder="Search notes…"
          placeholderTextColor="#3a3835"
          value={query}
          onChangeText={setQuery}
        />
      </View>

      {!activeProjectId ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: "#66635f", fontSize: 13 }}>Select a project from the Projects tab.</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#7c6af7" />}
        >
          {filtered.length === 0 && (
            <View style={{ alignItems: "center", paddingVertical: 60 }}>
              <Text style={{ color: "#66635f", fontSize: 13 }}>No notes found.</Text>
            </View>
          )}
          {pinned.length > 0 && (
            <>
              <Text style={{ color: "#7c6af7", fontSize: 10, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.8, marginTop: 4, marginBottom: 4 }}>
                Pinned
              </Text>
              {pinned.map((n) => <NoteRow key={n.id} note={n} onPress={() => router.push(`/note/${n.id}`)} />)}
              {rest.length > 0 && <View style={{ height: 1, backgroundColor: "#1f1f1f", marginVertical: 8 }} />}
            </>
          )}
          {rest.map((n) => <NoteRow key={n.id} note={n} onPress={() => router.push(`/note/${n.id}`)} />)}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
