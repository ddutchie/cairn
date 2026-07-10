import { useMemo, useState } from "react";
import { Text, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { createNote } from "@/db/queries";
import { reindexNote } from "@/notes/embeddings";
import { NoteEditorBody } from "@/components/NoteEditorBody";
import { ICON_CHECK } from "@/components/toolbar-icons";
import { useModalOpenHaptic, toolbarPress } from "@/haptics";
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
  useModalOpenHaptic();
  const { project, folder } = useLocalSearchParams<{ project: string; folder?: string }>();
  const router = useRouter();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const styles = useMemo(() => makeStyles(t), [t]);

  const fmt = useNoteFormattingToolbar(body, setBody);

  const canSave = title.trim().length > 0 || body.trim().length > 0;

  const save = () => {
    if (!project || !canSave) return;
    const id = createNote(project, title.trim() || "Untitled", body, folder ?? "");
    // Index the new note for on-device semantic search (fire-and-forget).
    reindexNote(id).catch(() => {});
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
          onPress={toolbarPress(save, "confirm")}
        >
          Save
        </Stack.Toolbar.Button>
      </Stack.Toolbar>

      <NoteEditorBody
        title={title}
        body={body}
        onTitle={setTitle}
        onBody={setBody}
        fmt={fmt}
        bottomInset={insets.bottom}
        autoFocus
        header={folder ? <Text style={styles.folder}>{folder}</Text> : null}
      />
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.background },
    folder: { ...typeScale.caption, color: t.accent, marginBottom: 8 },
  });
}
