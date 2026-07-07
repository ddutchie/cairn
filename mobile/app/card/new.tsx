import { useMemo, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, KeyboardAvoidingView, Platform } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { createTask, listColumns, type ColumnRow } from "@/db/queries";
import { useTheme, PRIORITY_COLOR, type Theme } from "@/theme";
import { ICON_CHECK } from "@/components/toolbar-icons";

const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

/**
 * New-task composer. `project` (id) required; `column` optionally pre-selects
 * the destination column (passed from the board). Falls back to the first
 * column. Creates the card locally so capture triggers stage it for sync.
 */
export default function NewCard() {
  const { project, column } = useLocalSearchParams<{ project: string; column?: string }>();
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
    router.replace(`/card/${id}`);
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Stack.Screen
        options={{
          title: "New Task",
          headerBackTitle: "Board",
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
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Title</Text>
        <TextInput style={styles.titleInput} value={title} onChangeText={setTitle} placeholder="Task title" placeholderTextColor={t.textTertiary} autoFocus multiline />

        <Text style={styles.label}>Priority</Text>
        <View style={styles.row}>
          {PRIORITIES.map((p) => (
            <Pressable
              key={p}
              onPress={() => setPriority(p)}
              style={[styles.chip, { borderColor: PRIORITY_COLOR[p] }, priority === p && { backgroundColor: PRIORITY_COLOR[p] }]}
            >
              <Text style={[styles.chipText, { color: priority === p ? t.accentFg : t.textSecondary }]}>{p}</Text>
            </Pressable>
          ))}
        </View>

        {columns.length > 0 && (
          <>
            <Text style={styles.label}>Column</Text>
            <View style={styles.row}>
              {columns.map((c) => (
                <Pressable
                  key={c.id}
                  onPress={() => setColumnId(c.id)}
                  style={[styles.chip, { borderColor: t.border }, columnId === c.id && { backgroundColor: t.accent, borderColor: t.accent }]}
                >
                  <Text style={{ color: columnId === c.id ? t.accentFg : t.textSecondary, fontSize: 13, fontWeight: "600" }}>{c.name}</Text>
                </Pressable>
              ))}
            </View>
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
    container: { flex: 1, backgroundColor: t.background },
    content: { padding: 18, paddingBottom: 60 },
    label: { fontSize: 12, fontWeight: "700", color: t.textTertiary, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 18, marginBottom: 8 },
    titleInput: { fontSize: 18, fontWeight: "600", color: t.textPrimary, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12 },
    row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
    chip: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1 },
    chipText: { fontSize: 13, fontWeight: "600", textTransform: "capitalize" },
    descInput: { fontSize: 15, lineHeight: 22, color: t.textPrimary, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12, minHeight: 160, fontFamily: "Menlo" },
  });
}
