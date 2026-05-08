/**
 * Notes tab — shows notes for the active project.
 */
import { View, Text, ScrollView, Pressable, RefreshControl, TextInput } from "react-native";
import { useRouter } from "expo-router";
import { useState, useCallback, useEffect } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { Search, Pin } from "lucide-react-native";
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

  useEffect(() => {
    if (activeProjectId) loadNotes(activeProjectId);
  }, [activeProjectId]);

  const onRefresh = useCallback(async () => {
    if (!activeProjectId) return;
    setRefreshing(true);
    await loadNotes(activeProjectId);
    setRefreshing(false);
  }, [activeProjectId]);

  const filtered = notes.filter((n) =>
    query.trim() === "" ||
    n.title.toLowerCase().includes(query.toLowerCase()) ||
    n.contentText.toLowerCase().includes(query.toLowerCase())
  );

  const pinned = filtered.filter((n) => n.isPinned);
  const unpinned = filtered.filter((n) => !n.isPinned);

  return (
    <SafeAreaView className="flex-1 bg-zinc-950" edges={["top"]}>
      {/* Header */}
      <View className="px-5 pt-4 pb-2">
        <Text className="text-white text-2xl font-bold tracking-tight">Notes</Text>
        {activeProject && (
          <Text className="text-zinc-500 text-sm mt-0.5">{activeProject.name}</Text>
        )}
      </View>

      {/* Search */}
      <View className="px-5 pb-3">
        <View className="flex-row items-center bg-zinc-900 rounded-xl px-3 gap-2">
          <Search color="#71717a" size={16} />
          <TextInput
            className="flex-1 text-white text-sm py-3"
            placeholder="Search notes…"
            placeholderTextColor="#52525b"
            value={query}
            onChangeText={setQuery}
          />
        </View>
      </View>

      {!activeProjectId ? (
        <View className="flex-1 items-center justify-center">
          <Text className="text-zinc-600 text-base">Select a project from the Projects tab.</Text>
        </View>
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerClassName="px-5 pb-8"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#6366f1" />
          }
        >
          {filtered.length === 0 && (
            <View className="items-center py-16">
              <Text className="text-zinc-600 text-base">No notes found.</Text>
            </View>
          )}

          {pinned.length > 0 && (
            <>
              <View className="flex-row items-center gap-1.5 mb-2 mt-1">
                <Pin color="#6366f1" size={13} />
                <Text className="text-indigo-400 text-xs font-semibold uppercase tracking-wider">
                  Pinned
                </Text>
              </View>
              {pinned.map((note) => (
                <NoteRow
                  key={note.id}
                  note={note}
                  onPress={() => router.push(`/note/${note.id}`)}
                />
              ))}
              {unpinned.length > 0 && <View className="h-px bg-zinc-800 my-3" />}
            </>
          )}

          {unpinned.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              onPress={() => router.push(`/note/${note.id}`)}
            />
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
