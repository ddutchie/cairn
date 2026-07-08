import { useLocalSearchParams, Stack, useRouter, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ScrollView,
  Text,
  TextInput,
  StyleSheet,
  View,
  Alert,
} from "react-native";
import { Pin } from "lucide-react-native";
import { KeyboardAwareScrollView, KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getNote, updateNote, tagsForNote, noteTagIds, setNoteTags, pinNote, softDeleteNote } from "@/db/queries";
import { MarkdownView } from "@/components/MarkdownView";
import { TagChips } from "@/components/TagChips";
import { TagPickerSheet } from "@/components/TagPickerSheet";
import { NoteEditorToolbar } from "@/components/NoteEditorToolbar";
import { WikilinkPickerSheet } from "@/components/WikilinkPickerSheet";
import { ICON_CHECK, ICON_CLOSE, ICON_EDIT, ICON_MORE, ICON_PIN, ICON_UNPIN, ICON_TAG, ICON_DELETE } from "@/components/toolbar-icons";
import { useNoteFormattingToolbar } from "@/notes/useNoteFormattingToolbar";
import { reindexNote } from "@/notes/embeddings";
import { useDataChanged } from "@/sync/useSyncStatus";
import { useTheme, TAB_BAR_BASE, type as typeScale, type Theme } from "@/theme";

/**
 * Note viewer / editor. A leaf screen (navigates only back), so both its routes
 * (root `app/note/[id]` and Projects-tab `app/(tabs)/projects/note/[id]`) render it
 * unchanged; the containing stack decides whether the tab bar stays visible.
 *
 * `nested` = rendered inside the Projects tab (tab bar visible), so the read
 * view adds tab-bar bottom padding; root-stack copies (Search/Graph/Conflicts)
 * pass it false.
 */
export function NoteDetailScreen({ nested = false }: { nested?: boolean }) {
  const { id, back } = useLocalSearchParams<{ id: string; back?: string }>();
  const router = useRouter();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  // Bottom padding so the note body scrolls clear of the tab bar (present only
  // in the nested Projects-tab flow) + home indicator; content still scrolls
  // behind the translucent bar. Root-stack copies have no tab bar.
  const viewBottomPad = 40 + insets.bottom + (nested ? TAB_BAR_BASE : 0);
  const [note, setNote] = useState(() => (id ? getNote(id) : null));

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(note?.title ?? "");
  const [body, setBody] = useState(note?.content ?? "");
  const [tagPickerOpen, setTagPickerOpen] = useState(false);

  // Editing toolbar state.
  const bodyRef = useRef<TextInput>(null);
  const fmt = useNoteFormattingToolbar(body, setBody);

  const styles = useMemo(() => makeStyles(t), [t]);

  // Re-read the note when the screen refocuses or inbound sync lands changes,
  // so the view reflects edits made on another device. Skip while editing so we
  // never clobber the user's in-progress changes.
  const reload = useCallback(() => {
    if (editing || !id) return;
    const fresh = getNote(id);
    if (!fresh) return;
    setNote(fresh);
    setTitle(fresh.title ?? "");
    setBody(fresh.content ?? "");
  }, [editing, id]);
  useFocusEffect(useCallback(() => reload(), [reload]));
  useDataChanged(reload);

  const isPinned = !!note?.is_pinned;

  const onPin = useCallback(() => {
    if (!note) return;
    pinNote(note.id, !isPinned);
    setNote(getNote(note.id));
  }, [note, isPinned]);

  const onTags = useCallback((tagIds: string[]) => {
    if (!note) return;
    setNoteTags(note.id, tagIds);
    setNote(getNote(note.id));
    setTagPickerOpen(false);
  }, [note]);

  // Toggling a task-list checkbox in the rendered preview rewrites the source
  // and persists immediately (mirrors the desktop live-preview toggle).
  const onToggleCheckbox = useCallback(
    (next: string) => {
      if (!note) return;
      updateNote(note.id, note.title ?? "Untitled", next);
      const fresh = getNote(note.id);
      setNote(fresh);
      setBody(fresh?.content ?? next);
    },
    [note],
  );

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
    // Refresh the on-device semantic index for just this note (incremental,
    // hash-gated, no-op when embeddings are unavailable). Fire-and-forget.
    reindexNote(note.id).catch(() => {});
  };
  const onCancel = () => {
    setTitle(note.title ?? "");
    setBody(note.content ?? "");
    setEditing(false);
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: editing ? "Edit note" : note.title || "Note",
          // Callers reaching this over the tab navigator (Graph/Search/Conflicts)
          // pass an explicit `back` label since the root stack can't infer the
          // origin tab's title; the in-tab Projects flow omits it.
          ...(back ? { headerBackTitle: back } : {}),
        }}
      />
      {editing ? (
        <>
          <Stack.Toolbar placement="left">
            <Stack.Toolbar.Button icon={ICON_CLOSE} accessibilityLabel="Cancel" onPress={onCancel}>
              Cancel
            </Stack.Toolbar.Button>
          </Stack.Toolbar>
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.Button icon={ICON_CHECK} variant="done" accessibilityLabel="Save" onPress={onSave}>
              Save
            </Stack.Toolbar.Button>
          </Stack.Toolbar>
        </>
      ) : (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Menu icon={ICON_MORE} accessibilityLabel="Note actions">
            <Stack.Toolbar.MenuAction
              icon={isPinned ? ICON_UNPIN : ICON_PIN}
              isOn={isPinned}
              onPress={onPin}
            >
              {isPinned ? "Unpin" : "Pin"}
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon={ICON_TAG} onPress={() => setTagPickerOpen(true)}>
              Edit tags
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon={ICON_DELETE} destructive onPress={onDelete}>
              Delete
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Button icon={ICON_EDIT} accessibilityLabel="Edit" onPress={() => setEditing(true)}>
            Edit
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
      )}

      {editing ? (
        <>
          <KeyboardAwareScrollView
            style={styles.scroll}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            bottomOffset={62}
          >
            <TextInput style={styles.titleInput} value={title} onChangeText={setTitle} placeholder="Title" placeholderTextColor={t.textTertiary} multiline />
            <TextInput
              ref={bodyRef}
              style={styles.bodyInput}
              value={body}
              onChangeText={setBody}
              selection={fmt.selection}
              onSelectionChange={fmt.onSelectionChange}
              placeholder="Write in Markdown…"
              placeholderTextColor={t.textTertiary}
              // Lock edits while an AI action is pending: onAIAction splices its
              // reply into the body snapshot captured at call time, so edits
              // made mid-request would be clobbered / spliced at stale offsets.
              editable={!fmt.aiLoading}
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
              bottomInset={insets.bottom + (nested ? TAB_BAR_BASE : 0)}
            />
          </KeyboardStickyView>
        </>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, { paddingBottom: viewBottomPad }]}>
          <View style={styles.titleRow}>
            {isPinned && <Pin size={16} color={t.accent} fill={t.accent} />}
            <Text style={styles.title}>{note.title || "Untitled"}</Text>
          </View>
          {note.folder ? <Text style={styles.folder}>{note.folder}</Text> : null}
          <TagChipsRow note={note} />
          <View style={styles.md}>
            <MarkdownView content={note.content ?? ""} onChangeContent={onToggleCheckbox} />
          </View>
        </ScrollView>
      )}

      <TagPickerSheet
        visible={tagPickerOpen}
        initialSelected={noteTagIds(note)}
        onDone={onTags}
        onClose={() => setTagPickerOpen(false)}
      />

      <WikilinkPickerSheet
        visible={fmt.wikilinkOpen}
        onSelect={fmt.onWikilink}
        onClose={fmt.closeWikilink}
      />
    </View>
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
    title: { ...typeScale.display, color: t.textPrimary, flexShrink: 1 },
    folder: { ...typeScale.caption, color: t.accent, marginTop: 4, marginBottom: 4 },
    md: { marginTop: 12 },
    titleInput: { ...typeScale.display, color: t.textPrimary, padding: 0 },
    bodyInput: { ...typeScale.body, color: t.textPrimary, marginTop: 16, fontFamily: "Menlo", minHeight: 320 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.background },
    missing: { color: t.textTertiary },
  });
}
