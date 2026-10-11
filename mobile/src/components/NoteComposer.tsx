import { useState } from "react";
import { Text, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { createNote } from "@/db/queries";
import { reindexNote } from "@/notes/embeddings";
import { NoteEditorBody } from "@/components/NoteEditorBody";
import { ScreenChrome } from "@/components/screen-chrome";
import { ICON_CHECK } from "@/components/toolbar-icons";
import { toolbarPress } from "@/haptics";
import { useNoteFormattingToolbar } from "@/notes/useNoteFormattingToolbar";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/**
 * New-note composer, shared by two hosts:
 *
 *   • the native modal route (`app/note/new.tsx`) — phone / folded Duo;
 *   • the split-view detail column (`ProjectsSplitView`) — unfolded Duo / iPad,
 *     where a half-window card parked on the left page is the wrong place to
 *     write (the system offers no sheet-placement API to move it right).
 *
 * `ScreenChrome` renders the title + Save in whichever container hosts this:
 * the native stack header as a route, the column's SwiftUI bar in a split
 * view. Save hides until there is content to save (columns have no disabled
 * button state — and the board's + already behaves this way).
 */
export function NoteComposer({
  projectId,
  folder,
  onSaved,
}: {
  projectId: string;
  folder?: string;
  onSaved: (id: string) => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const styles = makeStyles(t);

  const fmt = useNoteFormattingToolbar(body, setBody);

  const canSave = title.trim().length > 0 || body.trim().length > 0;

  const save = () => {
    if (!projectId || !canSave) return;
    const id = createNote(projectId, title.trim() || "Untitled", body, folder ?? "");
    // Index the new note for on-device semantic search (fire-and-forget).
    reindexNote(id).catch(() => {});
    onSaved(id);
  };

  return (
    <View style={styles.container}>
      <ScreenChrome
        title="New Note"
        back="Back"
        right={[
          {
            kind: "button",
            key: "save",
            label: "Save",
            icon: ICON_CHECK,
            variant: "done",
            hidden: !canSave,
            onPress: toolbarPress(save, "confirm"),
          },
        ]}
      />

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
