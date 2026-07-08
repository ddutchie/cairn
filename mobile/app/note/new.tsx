import { useMemo, useRef, useState } from "react";
import {
  Text,
  TextInput,
  StyleSheet,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { KeyboardAwareScrollView, KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { createNote } from "@/db/queries";
import { NoteEditorToolbar } from "@/components/NoteEditorToolbar";
import { WikilinkPickerSheet } from "@/components/WikilinkPickerSheet";
import { ICON_CHECK } from "@/components/toolbar-icons";
import { useNoteFormattingToolbar } from "@/notes/useNoteFormattingToolbar";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/**
 * New-note composer. `project` (id) is required; `folder` optionally pre-fills
 * the destination folder (passed from the project's folder tree). On save we
 * create the note locally (capture triggers stage it for sync) and replace the
 * route with the new note's detail screen.
 *
 * Carries the same formatting + AI toolbar as the note editor so Markdown
 * shortcuts, wikilinks, and AI text actions are available while composing.
 */
export default function NewNote() {
  const { project, folder } = useLocalSearchParams<{ project: string; folder?: string }>();
  const router = useRouter();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const styles = useMemo(() => makeStyles(t), [t]);

  // Editing toolbar state (mirrors note/[id]'s editing mode).
  const bodyRef = useRef<TextInput>(null);
  const fmt = useNoteFormattingToolbar(body, setBody);

  const canSave = title.trim().length > 0 || body.trim().length > 0;

  const save = () => {
    if (!project || !canSave) return;
    const id = createNote(project, title.trim() || "Untitled", body, folder ?? "");
    router.replace(`/note/${id}`);
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: "New Note",
          headerBackTitle: "Back",
        }}
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={ICON_CHECK}
          variant="done"
          disabled={!canSave}
          accessibilityLabel="Save"
          onPress={save}
        >
          Save
        </Stack.Toolbar.Button>
      </Stack.Toolbar>

      <KeyboardAwareScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        bottomOffset={62}
      >
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
          ref={bodyRef}
          style={styles.bodyInput}
          value={body}
          onChangeText={setBody}
          selection={fmt.selection}
          onSelectionChange={fmt.onSelectionChange}
          placeholder="Write in Markdown…"
          placeholderTextColor={t.textTertiary}
          multiline
          textAlignVertical="top"
        />
      </KeyboardAwareScrollView>

      <KeyboardStickyView>
        <NoteEditorToolbar
          onFormat={fmt.onFormat}
          onAction={fmt.onAIAction}
          hasSelection={fmt.hasSelection}
          aiEnabled
          loading={fmt.aiLoading}
          onDismiss={() => bodyRef.current?.blur()}
          bottomInset={insets.bottom}
        />
      </KeyboardStickyView>

      <WikilinkPickerSheet
        visible={fmt.wikilinkOpen}
        onSelect={fmt.onWikilink}
        onClose={fmt.closeWikilink}
      />
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.background },
    scroll: { flex: 1 },
    content: { padding: 18, paddingBottom: 64 },
    folder: { ...typeScale.caption, color: t.accent, marginBottom: 8 },
    titleInput: { ...typeScale.display, color: t.textPrimary, padding: 0 },
    bodyInput: { ...typeScale.body, color: t.textPrimary, marginTop: 16, fontFamily: "Menlo", minHeight: 320 },
  });
}
