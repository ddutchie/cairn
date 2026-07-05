import { useLocalSearchParams, Stack, useRouter } from "expo-router";
import { useState } from "react";
import {
  ScrollView,
  Text,
  TextInput,
  StyleSheet,
  View,
  Pressable,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { getNote, updateNote } from "@/db/queries";

export default function NoteDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const note = id ? getNote(id) : null;

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(note?.title ?? "");
  const [body, setBody] = useState(note?.content ?? "");

  if (!note) {
    return (
      <View style={styles.center}>
        <Text style={styles.missing}>Note not found</Text>
      </View>
    );
  }

  const onSave = () => {
    updateNote(note.id, title.trim() || "Untitled", body);
    setEditing(false);
    // Changes are now staged in sync_pending; the Sync tab publishes them.
  };

  const onCancel = () => {
    setTitle(note.title ?? "");
    setBody(note.content ?? "");
    setEditing(false);
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Stack.Screen
        options={{
          title: editing ? "Edit note" : note.title || "Note",
          headerRight: () =>
            editing ? (
              <Pressable onPress={onSave} hitSlop={12}>
                <Text style={styles.action}>Save</Text>
              </Pressable>
            ) : (
              <Pressable onPress={() => setEditing(true)} hitSlop={12}>
                <Text style={styles.action}>Edit</Text>
              </Pressable>
            ),
          headerLeft: editing
            ? () => (
                <Pressable onPress={onCancel} hitSlop={12}>
                  <Text style={styles.actionMuted}>Cancel</Text>
                </Pressable>
              )
            : undefined,
        }}
      />

      {editing ? (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <TextInput
            style={styles.titleInput}
            value={title}
            onChangeText={setTitle}
            placeholder="Title"
            multiline
          />
          <TextInput
            style={styles.bodyInput}
            value={body}
            onChangeText={setBody}
            placeholder="Write in Markdown…"
            multiline
            textAlignVertical="top"
          />
        </ScrollView>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <Text style={styles.title}>{note.title || "Untitled"}</Text>
          {note.folder ? <Text style={styles.folder}>{note.folder}</Text> : null}
          <Text style={styles.body}>{note.content ?? ""}</Text>
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  scroll: { flex: 1 },
  content: { padding: 18, paddingBottom: 48 },
  title: { fontSize: 22, fontWeight: "700", color: "#111" },
  folder: { fontSize: 12, color: "#8b5cf6", marginTop: 4 },
  body: { fontSize: 15, lineHeight: 22, color: "#222", marginTop: 16, fontFamily: "Menlo" },
  titleInput: { fontSize: 22, fontWeight: "700", color: "#111", padding: 0 },
  bodyInput: {
    fontSize: 15,
    lineHeight: 22,
    color: "#222",
    marginTop: 16,
    fontFamily: "Menlo",
    minHeight: 320,
  },
  action: { color: "#6366f1", fontSize: 16, fontWeight: "600" },
  actionMuted: { color: "#888", fontSize: 16 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  missing: { color: "#888" },
});
