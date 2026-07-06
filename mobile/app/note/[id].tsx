import { useLocalSearchParams, Stack, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  ScrollView,
  Text,
  TextInput,
  StyleSheet,
  View,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from "react-native";
import { MoreHorizontal, Pin } from "lucide-react-native";
import { getNote, updateNote, tagsForNote, pinNote, softDeleteNote } from "@/db/queries";
import { MarkdownView } from "@/components/MarkdownView";
import { TagChips } from "@/components/TagChips";
import { useTheme, type Theme } from "@/theme";

export default function NoteDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const t = useTheme();
  const [note, setNote] = useState(() => (id ? getNote(id) : null));

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(note?.title ?? "");
  const [body, setBody] = useState(note?.content ?? "");

  const styles = useMemo(() => makeStyles(t), [t]);

  const isPinned = !!note?.is_pinned;

  const onPin = useCallback(() => {
    if (!note) return;
    pinNote(note.id, !isPinned);
    setNote(getNote(note.id));
  }, [note, isPinned]);

  const onDelete = useCallback(() => {
    if (!note) return;
    Alert.alert("Delete note?", "This removes the note on all your devices. This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          softDeleteNote(note.id);
          router.back();
        },
      },
    ]);
  }, [note, router]);

  const onActions = useCallback(() => {
    Alert.alert(note?.title || "Note", undefined, [
      { text: isPinned ? "Unpin" : "Pin", onPress: onPin },
      { text: "Delete", style: "destructive", onPress: onDelete },
      { text: "Cancel", style: "cancel" },
    ]);
  }, [note, isPinned, onPin, onDelete]);

  if (!note) {
    return (
      <View style={styles.center}>
        <Text style={styles.missing}>Note not found</Text>
      </View>
    );
  }

  const onSave = () => {
    updateNote(note.id, title.trim() || "Untitled", body);
    setNote(getNote(note.id));
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
              <View style={styles.headerActions}>
                <Pressable onPress={() => setEditing(true)} hitSlop={12}>
                  <Text style={styles.action}>Edit</Text>
                </Pressable>
                <Pressable onPress={onActions} hitSlop={12}>
                  <MoreHorizontal size={22} color={t.accent} />
                </Pressable>
              </View>
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
          <View style={styles.titleRow}>
            {isPinned && <Pin size={16} color={t.accent} fill={t.accent} />}
            <Text style={styles.title}>{note.title || "Untitled"}</Text>
          </View>
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
    titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    title: { fontSize: 24, fontWeight: "700", color: t.textPrimary, flexShrink: 1 },
    headerActions: { flexDirection: "row", alignItems: "center", gap: 16 },
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
