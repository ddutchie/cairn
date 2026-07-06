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
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { createNote } from "@/db/queries";
import { useTheme, type Theme } from "@/theme";

/**
 * New-note composer. `project` (id) is required; `folder` optionally pre-fills
 * the destination folder (passed from the project's folder tree). On save we
 * create the note locally (capture triggers stage it for sync) and replace the
 * route with the new note's detail screen.
 */
export default function NewNote() {
  const { project, folder } = useLocalSearchParams<{ project: string; folder?: string }>();
  const router = useRouter();
  const t = useTheme();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const styles = useMemo(() => makeStyles(t), [t]);

  const canSave = title.trim().length > 0 || body.trim().length > 0;

  const save = () => {
    if (!project || !canSave) return;
    const id = createNote(project, title.trim() || "Untitled", body, folder ?? "");
    router.replace(`/note/${id}`);
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Stack.Screen
        options={{
          title: "New Note",
          headerBackTitle: "Back",
          headerRight: () => (
            <Pressable onPress={save} hitSlop={12} disabled={!canSave}>
              <Text style={[styles.action, !canSave && styles.actionDisabled]}>Save</Text>
            </Pressable>
          ),
        }}
      />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {folder ? <Text style={styles.folder}>{folder}</Text> : null}
        <TextInput
          style={styles.titleInput}
          value={title}
          onChangeText={setTitle}
          placeholder="Title"
          placeholderTextColor={t.textTertiary}
          autoFocus
          multiline
        />
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
    </KeyboardAvoidingView>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.background },
    scroll: { flex: 1 },
    content: { padding: 18, paddingBottom: 64 },
    folder: { fontSize: 12, color: t.accent, marginBottom: 8 },
    titleInput: { fontSize: 24, fontWeight: "700", color: t.textPrimary, padding: 0 },
    bodyInput: { fontSize: 15, lineHeight: 22, color: t.textPrimary, marginTop: 16, fontFamily: "Menlo", minHeight: 320 },
    action: { color: t.accent, fontSize: 16, fontWeight: "600" },
    actionDisabled: { color: t.textTertiary },
  });
}
