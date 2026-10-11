import { useMemo, useState } from "react";
import { Text, TextInput, ScrollView, StyleSheet, KeyboardAvoidingView, Platform, Alert } from "react-native";
import { createTask, listColumns, type ColumnRow } from "@/db/queries";
import { toolbarPress } from "@/haptics";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { ICON_CHECK } from "@/components/toolbar-icons";
import { ScreenChrome, useInColumn } from "@/components/screen-chrome";
import { PriorityChips, ColumnChips } from "@/components/TaskChips";

/**
 * New-task composer, shared by two hosts (like `NoteComposer`):
 *
 *   • the native modal route (`app/card/new.tsx`) — phone / folded Duo;
 *   • the split-view detail column (`ProjectsSplitView`) — unfolded Duo / iPad,
 *     where a modal would park on the left page (no sheet-placement API).
 *
 * `column` optionally pre-selects the destination column (from a board
 * column's "New task"); falls back to the first column. Save hides until
 * there is a title (columns have no disabled button state).
 */
export function TaskComposer({
  projectId,
  column,
  back,
  onSaved,
}: {
  projectId: string;
  column?: string;
  /** Route mode: the back-button label. */
  back?: string;
  onSaved: (id: string) => void;
}) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  // A column is part of the page (its bar is page-coloured); the modal is a card.
  const inColumn = useInColumn();
  // Memoize by project so the SQLite query doesn't re-run on every keystroke.
  const columns: ColumnRow[] = useMemo(() => (projectId ? listColumns(projectId) : []), [projectId]);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<string>("medium");
  const [columnId, setColumnId] = useState(column ?? columns[0]?.id ?? "");

  const canSave = title.trim().length > 0 && !!columnId;

  const save = () => {
    if (!projectId || !canSave) return;
    let id: string;
    try {
      id = createTask(projectId, columnId, title.trim(), { description, priority });
    } catch (e) {
      // The column can vanish while this form is open (deleted on another device).
      Alert.alert("Couldn't create the task", e instanceof Error ? e.message : String(e));
      return;
    }
    onSaved(id);
  };

  return (
    <KeyboardAvoidingView style={[styles.container, inColumn && { backgroundColor: t.background }]} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScreenChrome
        title="New Task"
        back={back || "Board"}
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
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Title</Text>
        <TextInput style={styles.titleInput} value={title} onChangeText={setTitle} placeholder="Task title" placeholderTextColor={t.textTertiary} autoFocus multiline />

        <Text style={styles.label}>Priority</Text>
        <PriorityChips value={priority} onChange={setPriority} />

        {columns.length > 0 && (
          <>
            <Text style={styles.label}>Column</Text>
            <ColumnChips columns={columns} value={columnId} onChange={setColumnId} />
          </>
        )}

        <Text style={styles.label}>Description</Text>
        <TextInput
          style={styles.descInput}
          value={description}
          onChangeText={setDescription}
          placeholder="Add a description (markdown)…"
          placeholderTextColor={t.textTertiary}
          multiline
          textAlignVertical="top"
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.surface },
    content: { padding: 18, paddingBottom: 60 },
    label: { ...typeScale.overline, color: t.textTertiary, marginTop: 18, marginBottom: 8 },
    titleInput: { ...typeScale.title, color: t.textPrimary, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12 },
    descInput: { ...typeScale.body, color: t.textPrimary, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12, minHeight: 160, fontFamily: "Menlo" },
  });
}
