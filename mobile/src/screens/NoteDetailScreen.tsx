import { useLocalSearchParams, Stack, useRouter, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ScrollView,
  Text,
  TextInput,
  StyleSheet,
  View,
  Alert,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
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
import { applyFormat, insertWikilink, type FormatAction, type Selection } from "@cairn/shared/notes/format";
import { buildAIActionPrompt, type AITextAction } from "@cairn/shared/notes/ai-actions";
import { runTextAction } from "@/chat/agent";
import { useDataChanged } from "@/sync/useSyncStatus";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/** Standard UIKit tab bar height (excludes the home-indicator inset). */
const TAB_BAR_BASE = 49;

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
  const [selection, setSelection] = useState<Selection>({ start: 0, end: 0 });
  const selectionRef = useRef<Selection>({ start: 0, end: 0 });
  const [aiLoading, setAiLoading] = useState(false);
  const [wikilinkOpen, setWikilinkOpen] = useState(false);

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

  const onSelectionChange = useCallback(
    (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      selectionRef.current = e.nativeEvent.selection;
      setSelection(e.nativeEvent.selection);
    },
    [],
  );

  const hasSelection = selection.end > selection.start;

  // Apply a formatting action to the body at the current selection, then restore
  // the (shifted) selection so the caret lands sensibly.
  const onFormat = useCallback(
    (action: FormatAction) => {
      if (action === "wikilink") {
        setWikilinkOpen(true);
        return;
      }
      const res = applyFormat(body, selectionRef.current, action);
      if (!res) return;
      setBody(res.text);
      selectionRef.current = res.selection;
      setSelection(res.selection);
    },
    [body],
  );

  const onWikilink = useCallback(
    (noteTitle: string) => {
      const res = insertWikilink(body, selectionRef.current, noteTitle);
      setBody(res.text);
      selectionRef.current = res.selection;
      setSelection(res.selection);
      setWikilinkOpen(false);
    },
    [body],
  );

  // Run an AI text action over the current selection and replace it with the
  // model's reply (online only, via Rork).
  const onAIAction = useCallback(
    async (action: AITextAction, customPrompt?: string) => {
      const sel = selectionRef.current;
      const selected = body.slice(sel.start, sel.end);
      if (!selected) return;
      setAiLoading(true);
      try {
        const prompt = buildAIActionPrompt(action, selected, customPrompt);
        const reply = await runTextAction(prompt);
        if (!reply) return;
        const next = body.slice(0, sel.start) + reply + body.slice(sel.end);
        const newSel = { start: sel.start, end: sel.start + reply.length };
        setBody(next);
        selectionRef.current = newSel;
        setSelection(newSel);
      } catch (e) {
        Alert.alert(
          "AI action failed",
          e instanceof Error && /network|fetch|connect|\(5\d\d\)/i.test(e.message)
            ? "This needs a connection. Reconnect and try again."
            : "Something went wrong. Try again.",
        );
      } finally {
        setAiLoading(false);
      }
    },
    [body],
  );

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
              selection={selection}
              onSelectionChange={onSelectionChange}
              placeholder="Write in Markdown…"
              placeholderTextColor={t.textTertiary}
              multiline
              textAlignVertical="top"
            />
          </KeyboardAwareScrollView>
          <KeyboardStickyView>
            <NoteEditorToolbar
              onFormat={onFormat}
              onAction={onAIAction}
              hasSelection={hasSelection}
              aiEnabled
              loading={aiLoading}
              onDismiss={() => bodyRef.current?.blur()}
              bottomInset={insets.bottom}
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
        visible={wikilinkOpen}
        onSelect={onWikilink}
        onClose={() => setWikilinkOpen(false)}
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
