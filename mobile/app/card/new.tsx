import { useMemo, useState } from "react";
import { Text, TextInput, ScrollView, StyleSheet, KeyboardAvoidingView, Platform } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { createTask, listColumns, type ColumnRow } from "@/db/queries";
import { useModalOpenHaptic, toolbarPress } from "@/haptics";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { ICON_CHECK } from "@/components/toolbar-icons";
import { PriorityChips, ColumnChips } from "@/components/TaskChips";

/**
 * New-task composer. `project` (id) required; `column` optionally pre-selects
 * the destination column (passed from the board). Falls back to the first
 * column. Creates the card locally so capture triggers stage it for sync.
 */
export default function NewCard() {
  useModalOpenHaptic();
  const { project, column, back } = useLocalSearchParams<{ project: string; column?: string; back?: string }>();
  const router = useRouter();
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  // Memoize by `project` so the SQLite query doesn't re-run on every keystroke.
  const columns: ColumnRow[] = useMemo(() => (project ? listColumns(project) : []), [project]);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<string>("medium");
  const [columnId, setColumnId] = useState(column ?? columns[0]?.id ?? "");

  const canSave = title.trim().length > 0 && !!columnId;

  const save = () => {
    if (!project || !canSave) return;
    const id = createTask(project, columnId, title.trim(), { description, priority });
    // Replace this modal with the new card's detail. Forward `back` (the project
    // name) so the card's header shows "< {Project}" instead of the raw route
    // group name ("(tabs)") — the root-stack card route can't infer the
    // originating tab's title on its own.
    router.replace({ pathname: "/card/[id]", params: { id, ...(back ? { back } : {}) } });
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Stack.Screen
        options={{
          title: "New Task",
          headerBackTitle: back || "Board",
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
