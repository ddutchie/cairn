import { useCallback, useMemo, useRef, useState } from "react";
import {
  Text,
  TextInput,
  StyleSheet,
  View,
  Alert,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { KeyboardAwareScrollView, KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { createNote } from "@/db/queries";
import { NoteEditorToolbar } from "@/components/NoteEditorToolbar";
import { WikilinkPickerSheet } from "@/components/WikilinkPickerSheet";
import { ICON_CHECK } from "@/components/toolbar-icons";
import { applyFormat, insertWikilink, type FormatAction, type Selection } from "@cairn/shared/notes/format";
import { buildAIActionPrompt, type AITextAction } from "@cairn/shared/notes/ai-actions";
import { runTextAction } from "@/chat/agent";
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
  const [selection, setSelection] = useState<Selection>({ start: 0, end: 0 });
  const selectionRef = useRef<Selection>({ start: 0, end: 0 });
  const [aiLoading, setAiLoading] = useState(false);
  const [wikilinkOpen, setWikilinkOpen] = useState(false);

  const canSave = title.trim().length > 0 || body.trim().length > 0;

  const save = () => {
    if (!project || !canSave) return;
    const id = createNote(project, title.trim() || "Untitled", body, folder ?? "");
    router.replace(`/note/${id}`);
  };

  const onSelectionChange = useCallback(
    (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      selectionRef.current = e.nativeEvent.selection;
      setSelection(e.nativeEvent.selection);
    },
    [],
  );

  const hasSelection = selection.end > selection.start;

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

      <WikilinkPickerSheet
        visible={wikilinkOpen}
        onSelect={onWikilink}
        onClose={() => setWikilinkOpen(false)}
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
