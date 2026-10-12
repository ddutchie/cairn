import { useCallback, useRef, useState } from "react";
import { ActionSheetIOS, Alert, Platform, type TextInputSelectionChangeEvent } from "react-native";
import { useRouter } from "expo-router";
import { applyFormat, insertEmbedAtSelection, insertWikilink, type FormatAction, type Selection } from "@cairn/shared/notes/format";
import { buildAIActionPrompt, type AITextAction } from "@cairn/shared/notes/ai-actions";
import { runTextAction } from "@/chat/agent";
import {
  addImageFromSource,
  clipboardHasImage,
  InsertImageError,
  type ImageSource,
} from "@/notes/insert-image";
import { newSheetResultKey, registerSheetResult } from "@/lib/sheet-result";

/**
 * Shared editor-toolbar behaviour for the note composer and the note editor.
 *
 * Both screens drive the same `NoteEditorToolbar` + the native wikilink sheet
 * (app/picker/wikilink.tsx): track the TextInput selection, apply Markdown
 * formatting, insert wikilinks, and run AI text actions over the selection. The
 * screens own `body`/`setBody` (the detail screen also resets `body` on
 * sync/refocus), so those are passed in and this hook manages everything else,
 * returning an identical API for both.
 *
 * Wire it up:
 *   const fmt = useNoteFormattingToolbar(body, setBody);
 *   <TextInput selection={fmt.selection} onSelectionChange={fmt.onSelectionChange} … />
 *   <NoteEditorToolbar onFormat={fmt.onFormat} onAction={fmt.onAIAction}
 *                      hasSelection={fmt.hasSelection} loading={fmt.aiLoading} … />
 * The "wikilink" format action opens the native formSheet picker
 * (app/picker/wikilink.tsx) and inserts the chosen title at the selection.
 */
export function useNoteFormattingToolbar(body: string, setBody: (next: string) => void) {
  const router = useRouter();
  const [selection, setSelection] = useState<Selection>({ start: 0, end: 0 });
  const selectionRef = useRef<Selection>({ start: 0, end: 0 });
  const [aiLoading, setAiLoading] = useState(false);

  const onSelectionChange = useCallback(
    (e: TextInputSelectionChangeEvent) => {
      selectionRef.current = e.nativeEvent.selection;
      setSelection(e.nativeEvent.selection);
    },
    [],
  );

  const hasSelection = selection.end > selection.start;

  // Open the native wikilink picker; the chosen title returns via the
  // sheet-result bus and is inserted at the current selection.
  const openWikilink = useCallback(() => {
    const key = newSheetResultKey();
    registerSheetResult<string>(key, (noteTitle) => {
      const res = insertWikilink(body, selectionRef.current, noteTitle);
      setBody(res.text);
      selectionRef.current = res.selection;
      setSelection(res.selection);
    });
    router.push({ pathname: "/picker/wikilink", params: { resultKey: key } });
  }, [body, setBody, router]);

  // Apply a formatting action to the body at the current selection, then restore
  // the (shifted) selection so the caret lands sensibly.
  const onFormat = useCallback(
    (action: FormatAction) => {
      if (action === "wikilink") {
        openWikilink();
        return;
      }
      const res = applyFormat(body, selectionRef.current, action);
      if (!res) return;
      setBody(res.text);
      selectionRef.current = res.selection;
      setSelection(res.selection);
    },
    [body, setBody, openWikilink],
  );

  // Run an AI text action over the current selection and replace it with the
  // model's reply.
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
    [body, setBody],
  );

  // Add an image (library / camera / clipboard) and embed it at the caret.
  const [imageBusy, setImageBusy] = useState(false);
  const insertImage = useCallback(
    async (source: ImageSource) => {
      setImageBusy(true);
      try {
        const embed = await addImageFromSource(source);
        if (!embed) return; // cancelled
        const res = insertEmbedAtSelection(body, selectionRef.current, embed);
        setBody(res.text);
        selectionRef.current = res.selection;
        setSelection(res.selection);
      } catch (e) {
        Alert.alert(
          "Couldn't add image",
          e instanceof InsertImageError ? e.message : "Something went wrong. Try again.",
        );
      } finally {
        setImageBusy(false);
      }
    },
    [body, setBody],
  );

  const onInsertImage = useCallback(async () => {
    const canPaste = await clipboardHasImage();
    const options: { label: string; source: ImageSource }[] = [
      { label: "Photo Library", source: "library" },
      { label: "Take Photo", source: "camera" },
      ...(canPaste ? [{ label: "Paste Image", source: "clipboard" as const }] : []),
    ];
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [...options.map((o) => o.label), "Cancel"], cancelButtonIndex: options.length },
        (i) => {
          if (i < options.length) void insertImage(options[i].source);
        },
      );
    } else {
      Alert.alert("Add image", undefined, [
        ...options.map((o) => ({ text: o.label, onPress: () => void insertImage(o.source) })),
        { text: "Cancel", style: "cancel" as const },
      ]);
    }
  }, [insertImage]);

  return {
    selection,
    hasSelection,
    imageBusy,
    onInsertImage,
    aiLoading,
    onSelectionChange,
    onFormat,
    onAIAction,
    openWikilink,
  };
}
