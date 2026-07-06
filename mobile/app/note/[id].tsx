import { useLocalSearchParams, Stack } from "expo-router";
import { useMemo, useState } from "react";
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
import { getNote, updateNote, tagsForNote } from "@/db/queries";
import { MarkdownView } from "@/components/MarkdownView";
import { TagChips } from "@/components/TagChips";
import { useTheme, type Theme } from "@/theme";

export default function NoteDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const note = id ? getNote(id) : null;

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(note?.title ?? "");
  const [body, setBody] = useState(note?.content ?? "");

  const styles = useMemo(() => makeStyles(t), [t]);

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
  };
  const onCancel = () => {
    setTitle(note.title ?? "");
    setBody(note.content ?? "");
    setEditing(false);
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
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
          <TextInput style={styles.titleInput} value={title} onChangeText={setTitle} placeholder="Title" placeholderTextColor={t.textTertiary} multiline />
          <TextInput
            style={styles.bodyInput}
            value={body}
            onChangeText={setBody}
            placeholder="Write in Markdown…"
            placeholderTextColor={t.textTertiary}
            multiline
            textAlignVertical="top"
          />
        </ScrollView>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <Text style={styles.title}>{note.title || "Untitled"}</Text>
          {note.folder ? <Text style={styles.folder}>{note.folder}</Text> : null}
          <TagChipsRow note={note} />
          <View style={styles.md}>
            <MarkdownView content={note.content ?? ""} />
          </View>
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}

function TagChipsRow({ note }: { note: { tag_ids: string } }) {
  const tags = tagsForNote(note);
  if (!tags.length) return null;
  return (
    <View style={{ marginTop: 10 }}>
      <TagChips tags={tags} size="sm" />
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.background },
    scroll: { flex: 1 },
    content: { padding: 18, paddingBottom: 64 },
    title: { fontSize: 24, fontWeight: "700", color: t.textPrimary },
    folder: { fontSize: 12, color: t.accent, marginTop: 4, marginBottom: 4 },
    md: { marginTop: 12 },
    titleInput: { fontSize: 24, fontWeight: "700", color: t.textPrimary, padding: 0 },
    bodyInput: { fontSize: 15, lineHeight: 22, color: t.textPrimary, marginTop: 16, fontFamily: "Menlo", minHeight: 320 },
    action: { color: t.accent, fontSize: 16, fontWeight: "600" },
    actionMuted: { color: t.textTertiary, fontSize: 16 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.background },
    missing: { color: t.textTertiary },
  });
}
