import { useRef, type ReactNode } from "react";
import { TextInput, StyleSheet } from "react-native";
import { KeyboardAwareScrollView, KeyboardStickyView } from "react-native-keyboard-controller";
import { NoteEditorToolbar } from "@/components/NoteEditorToolbar";
import type { useNoteFormattingToolbar } from "@/notes/useNoteFormattingToolbar";
import { useTheme, type as typeScale } from "@/theme";

type Fmt = ReturnType<typeof useNoteFormattingToolbar>;

/**
 * The Markdown note-editing surface shared by the new-note composer
 * (`app/note/new.tsx`) and the note detail screen's editing mode
 * (`NoteDetailScreen`): a keyboard-aware scroll view with a title input, a
 * monospace body input, a keyboard-sticky `NoteEditorToolbar`, and the wikilink
 * picker sheet — all wired to the same `useNoteFormattingToolbar` result.
 *
 * The two call sites differ only in `bottomInset` (a nested note detail adds the
 * tab-bar height) and an optional `header` (the new-note composer shows the
 * destination folder above the title).
 */
export function NoteEditorBody({
  title,
  body,
  onTitle,
  onBody,
  fmt,
  bottomInset,
  header,
  autoFocus = false,
}: {
  title: string;
  body: string;
  onTitle: (v: string) => void;
  onBody: (v: string) => void;
  fmt: Fmt;
  /** Safe-area padding below the sticky toolbar (add TAB_BAR_BASE when nested). */
  bottomInset: number;
  /** Optional content above the title input (e.g. the folder label). */
  header?: ReactNode;
  autoFocus?: boolean;
}) {
  const t = useTheme();
  const bodyRef = useRef<TextInput>(null);

  return (
    <>
      <KeyboardAwareScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        bottomOffset={62}
      >
        {header}
        <TextInput
          style={[styles.titleInput, { color: t.textPrimary }]}
          value={title}
          onChangeText={onTitle}
          placeholder="Title"
          placeholderTextColor={t.textTertiary}
          autoFocus={autoFocus}
          multiline
        />
        <TextInput
          ref={bodyRef}
          style={[styles.bodyInput, { color: t.textPrimary }]}
          value={body}
          onChangeText={onBody}
          selection={fmt.selection}
          onSelectionChange={fmt.onSelectionChange}
          placeholder="Write in Markdown…"
          placeholderTextColor={t.textTertiary}
          // Lock edits while an AI action is pending: onAIAction splices its
          // reply into the body snapshot captured at call time, so edits made
          // mid-request would be clobbered / spliced at stale offsets.
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
          bottomInset={bottomInset}
        />
      </KeyboardStickyView>
    </>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: 18, paddingBottom: 64 },
  titleInput: { ...typeScale.display, padding: 0 },
  bodyInput: { ...typeScale.body, marginTop: 16, fontFamily: "Menlo", minHeight: 320 },
});
