import { useRef, useState, type ReactNode } from "react";
import { View, TextInput, StyleSheet, useWindowDimensions, type LayoutChangeEvent, type TextInputInstance } from "react-native";
import { KeyboardAwareScrollView, useKeyboardState } from "react-native-keyboard-controller";
import { RestingStickyView } from "@/components/chat/RestingStickyView";
import { NoteEditorToolbar } from "@/components/NoteEditorToolbar";
import type { useNoteFormattingToolbar } from "@/notes/useNoteFormattingToolbar";
import { useTheme, useFont, resolveRNFontFamily, type as typeScale } from "@/theme";

type Fmt = ReturnType<typeof useNoteFormattingToolbar>;

/**
 * The Markdown note-editing surface shared by the new-note composer
 * (`app/note/new.tsx`) and the note detail screen's editing mode
 * (`NoteDetailScreen`): a keyboard-aware scroll view with a title input, a
 * body input (font follows the user's note-font preset), a keyboard-sticky
 * `NoteEditorToolbar`, and the wikilink picker sheet — all wired to the same
 * `useNoteFormattingToolbar` result.
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
  const fontId = useFont();
  const fontFamily = resolveRNFontFamily(fontId);
  const bodyRef = useRef<TextInputInstance>(null);

  // The toolbar is an overlay on a full-height wrapper, like the chat composer, and
  // rides the keyboard. Inside a SwiftUI split view / preview pane the hosting layer
  // also shrinks the wrapper for the keyboard, so its bottom already meets the
  // keyboard's top: lifting by the whole keyboard height again counted it twice and
  // left the toolbars under the header. Detect that from the wrapper's own size
  // (onLayout; measureInWindow is unreliable inside the hosting layer): if it shrank
  // by a good part of the keyboard, no extra lift is needed; otherwise (a plain
  // full-window route) lift by the whole keyboard, as before.
  const keyboardVisible = useKeyboardState((st) => st.isVisible);
  const keyboardHeight = useKeyboardState((st) => st.height);
  const { height: windowHeight } = useWindowDimensions();
  const [size, setSize] = useState({ tallest: 0, current: 0, window: windowHeight });
  const onWrapLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    setSize((c) => {
      const tallest = c.window !== windowHeight ? h : Math.max(c.tallest, h);
      return tallest === c.tallest && h === c.current && c.window === windowHeight ? c : { tallest, current: h, window: windowHeight };
    });
  };
  const alreadyResized = keyboardVisible && keyboardHeight > 0 && size.tallest - size.current > keyboardHeight * 0.4;
  // opened offset is added to the library's -keyboardHeight translation: +keyboard cancels it.
  const lift = alreadyResized ? keyboardHeight : 0;

  return (
    <View style={styles.wrap} onLayout={onWrapLayout}>
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
          style={[styles.bodyInput, { color: t.textPrimary, fontFamily }]}
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

      <RestingStickyView offset={{ closed: 0, opened: lift }} style={styles.toolbarOverlay}>
        <NoteEditorToolbar
          onFormat={fmt.onFormat}
          onAction={fmt.onAIAction}
          hasSelection={fmt.hasSelection}
          aiEnabled
          loading={fmt.aiLoading}
          onDismiss={() => bodyRef.current?.blur()}
          bottomInset={bottomInset}
          onInsertImage={fmt.onInsertImage}
          imageBusy={fmt.imageBusy}
        />
      </RestingStickyView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  toolbarOverlay: { position: "absolute", left: 0, right: 0, bottom: 0 },
  scroll: { flex: 1 },
  // Room for the overlaid toolbars (two rows) under the last line.
  content: { padding: 18, paddingBottom: 190 },
  titleInput: { ...typeScale.display, padding: 0 },
  bodyInput: { ...typeScale.body, marginTop: 16, minHeight: 320 },
});
