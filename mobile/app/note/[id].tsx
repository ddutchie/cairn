import { useLocalSearchParams, Stack, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ScrollView,
  Text,
  TextInput,
  StyleSheet,
  View,
  Pressable,
  Alert,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from "react-native";
import { MoreHorizontal, Pin } from "lucide-react-native";
import { KeyboardAwareScrollView, KeyboardStickyView } from "react-native-keyboard-controller";
import { getNote, updateNote, tagsForNote, noteTagIds, setNoteTags, pinNote, softDeleteNote } from "@/db/queries";
import { MarkdownView } from "@/components/MarkdownView";
import { TagChips } from "@/components/TagChips";
import { TagPickerSheet } from "@/components/TagPickerSheet";
import { NoteEditorToolbar } from "@/components/NoteEditorToolbar";
import { WikilinkPickerSheet } from "@/components/WikilinkPickerSheet";
import { applyFormat, insertWikilink, type FormatAction, type Selection } from "@cairn/shared/notes/format";
import { buildAIActionPrompt, type AITextAction } from "@cairn/shared/notes/ai-actions";
import { runTextAction } from "@/chat/agent";
import { useTheme, type Theme } from "@/theme";

export default function NoteDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const t = useTheme();
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

  const onActions = useCallback(() => {
    Alert.alert(note?.title || "Note", undefined, [
      { text: isPinned ? "Unpin" : "Pin", onPress: onPin },
      { text: "Edit tags", onPress: () => setTagPickerOpen(true) },
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
    <View style={styles.container}>
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
            />
          </KeyboardStickyView>
        </>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
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
