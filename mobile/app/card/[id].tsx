import { useMemo, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, KeyboardAvoidingView, Platform, Alert } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { Calendar, X } from "lucide-react-native";
import { getCard, listColumns, updateTask, moveCardToColumn, archiveCard, tagsForCard, noteTagIds, setCardTags, type ColumnRow } from "@/db/queries";
import { TagChips } from "@/components/TagChips";
import { TagPickerSheet } from "@/components/TagPickerSheet";
import { DueDatePickerSheet } from "@/components/DueDatePickerSheet";
import { MarkdownView } from "@/components/MarkdownView";
import { ICON_CHECK, ICON_MORE, ICON_ARCHIVE } from "@/components/toolbar-icons";
import { formatDate } from "@cairn/shared/format/date";
import { useTheme, PRIORITY_COLOR, type Theme } from "@/theme";

const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export default function CardDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const t = useTheme();
  const card = id ? getCard(id) : null;
  const styles = useMemo(() => makeStyles(t), [t]);

  const [title, setTitle] = useState(card?.title ?? "");
  const [description, setDescription] = useState(card?.description ?? "");
  const [priority, setPriority] = useState(card?.priority ?? "medium");
  const [columnId, setColumnId] = useState(card?.column_id ?? "");
  const [dueDate, setDueDate] = useState<string | null>(card?.due_date ?? null);
  const [assignee, setAssignee] = useState(card?.assignee ?? "");
  const [tagIds, setTagIds] = useState<string[]>(card ? noteTagIds(card) : []);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [descPreview, setDescPreview] = useState(false);
  const columns: ColumnRow[] = card ? listColumns(card.project_id) : [];
  const tags = useMemo(() => (card ? tagsForCard({ tag_ids: JSON.stringify(tagIds) }) : []), [card, tagIds]);

  if (!card) {
    return (
      <View style={styles.center}>
        <Text style={styles.missing}>Task not found</Text>
      </View>
    );
  }

  const save = () => {
    updateTask(card.id, {
      title: title.trim() || "Untitled",
      description,
      priority,
      dueDate,
      assignee: assignee.trim() || null,
    });
    setCardTags(card.id, tagIds);
    if (columnId && columnId !== card.column_id) moveCardToColumn(card.id, columnId);
    router.back();
  };

  const onArchive = () => {
    Alert.alert("Archive task?", "Archived tasks are removed from the board but kept in your data.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Archive",
        style: "destructive",
        onPress: () => {
          archiveCard(card.id);
          router.back();
        },
      },
    ]);
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Stack.Screen
        options={{
          title: "Edit Task",
          headerBackTitle: "Board",
        }}
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon={ICON_MORE} accessibilityLabel="Task actions">
          <Stack.Toolbar.MenuAction icon={ICON_ARCHIVE} destructive onPress={onArchive}>
            Archive
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.Button icon={ICON_CHECK} variant="done" accessibilityLabel="Save" onPress={save}>
          Save
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Title</Text>
        <TextInput style={styles.titleInput} value={title} onChangeText={setTitle} placeholder="Task title" placeholderTextColor={t.textTertiary} multiline />

        <Text style={styles.label}>Tags</Text>
        <Pressable onPress={() => setTagPickerOpen(true)}>
          {tags.length > 0 ? (
            <TagChips tags={tags} />
          ) : (
            <Text style={styles.placeholder}>Tap to add tags…</Text>
          )}
        </Pressable>

        <Text style={styles.label}>Priority</Text>
        <View style={styles.priorityRow}>
          {PRIORITIES.map((p) => (
            <Pressable
              key={p}
              onPress={() => setPriority(p)}
              style={[styles.priorityChip, { borderColor: PRIORITY_COLOR[p] }, priority === p && { backgroundColor: PRIORITY_COLOR[p] }]}
            >
              <Text style={[styles.priorityText, { color: priority === p ? "#fff" : t.textSecondary }]}>{p}</Text>
            </Pressable>
          ))}
        </View>

        {columns.length > 0 && (
          <>
            <Text style={styles.label}>Column</Text>
            <View style={styles.columnRow}>
              {columns.map((c) => (
                <Pressable
                  key={c.id}
                  onPress={() => setColumnId(c.id)}
                  style={[styles.columnChip, { borderColor: t.border }, columnId === c.id && { backgroundColor: t.accent, borderColor: t.accent }]}
                >
                  <Text style={{ color: columnId === c.id ? t.accentFg : t.textSecondary, fontSize: 13, fontWeight: "600" }}>{c.name}</Text>
                </Pressable>
              ))}
            </View>
          </>
        )}

        <Text style={styles.label}>Due date</Text>
        <View style={styles.dueRow}>
          <Pressable style={styles.dueButton} onPress={() => setShowDatePicker(true)}>
            <Calendar size={16} color={t.textSecondary} />
            <Text style={[styles.dueText, !dueDate && { color: t.textTertiary }]}>
              {dueDate ? formatDate(dueDate) : "No due date"}
            </Text>
          </Pressable>
          {dueDate && (
            <Pressable style={styles.dueClear} onPress={() => setDueDate(null)} hitSlop={8}>
              <X size={16} color={t.textTertiary} />
            </Pressable>
          )}
        </View>
        <Text style={styles.label}>Assignee</Text>
        <TextInput
          style={styles.assigneeInput}
          value={assignee}
          onChangeText={setAssignee}
          placeholder="Unassigned"
          placeholderTextColor={t.textTertiary}
          autoCapitalize="words"
        />

        <View style={styles.descHeader}>
          <Text style={[styles.label, { marginBottom: 0 }]}>Description</Text>
          {description.trim().length > 0 && (
            <Pressable onPress={() => setDescPreview((v) => !v)} hitSlop={8}>
              <Text style={styles.descToggle}>{descPreview ? "Edit" : "Preview"}</Text>
            </Pressable>
          )}
        </View>
        {descPreview ? (
          <View style={styles.descPreview}>
            <MarkdownView content={description} onChangeContent={setDescription} />
          </View>
        ) : (
          <TextInput
            style={styles.descInput}
            value={description}
            onChangeText={setDescription}
            placeholder="Add a description (markdown)…"
            placeholderTextColor={t.textTertiary}
            multiline
            textAlignVertical="top"
          />
        )}
      </ScrollView>

      <TagPickerSheet
        visible={tagPickerOpen}
        initialSelected={tagIds}
        onDone={(ids) => {
          setTagIds(ids);
          setTagPickerOpen(false);
        }}
        onClose={() => setTagPickerOpen(false)}
      />

      <DueDatePickerSheet
        visible={showDatePicker}
        initial={dueDate}
        onDone={(iso) => {
          setDueDate(iso);
          setShowDatePicker(false);
        }}
        onClose={() => setShowDatePicker(false)}
      />
    </KeyboardAvoidingView>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.background },
    content: { padding: 18, paddingBottom: 60 },
    label: { fontSize: 12, fontWeight: "700", color: t.textTertiary, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 18, marginBottom: 8 },
    titleInput: { fontSize: 18, fontWeight: "600", color: t.textPrimary, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12 },
    priorityRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
    priorityChip: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1 },
    priorityText: { fontSize: 13, fontWeight: "600", textTransform: "capitalize" },
    placeholder: { fontSize: 14, color: t.textTertiary, fontStyle: "italic" },
    dueRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    dueButton: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface },
    dueText: { fontSize: 15, color: t.textPrimary, fontWeight: "500" },
    dueClear: { padding: 6 },
    assigneeInput: { fontSize: 15, color: t.textPrimary, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12 },
    columnRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
    columnChip: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1 },
    descInput: { fontSize: 15, lineHeight: 22, color: t.textPrimary, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12, minHeight: 160, fontFamily: "Menlo" },
    descHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 18, marginBottom: 8 },
    descToggle: { fontSize: 13, color: t.accent, fontWeight: "600" },
    descPreview: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 4, minHeight: 160 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.background },
    missing: { color: t.textTertiary },
  });
}
