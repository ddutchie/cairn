import { useMemo, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, KeyboardAvoidingView, Platform, Alert } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { Calendar, X } from "lucide-react-native";
import { getCard, listColumns, listCards, updateTask, moveCardToColumn, archiveCard, deleteCard, tagsForCard, noteTagIds, setCardTags, type ColumnRow } from "@/db/queries";
import { TagChips } from "@/components/TagChips";
import { TagPickerSheet } from "@/components/TagPickerSheet";
import { DueDatePickerSheet } from "@/components/DueDatePickerSheet";
import { MarkdownView } from "@/components/MarkdownView";
import { PriorityChips, ColumnChips } from "@/components/TaskChips";
import { NotFound } from "@/components/NotFound";
import { ICON_CHECK, ICON_MORE, ICON_ARCHIVE, ICON_DELETE } from "@/components/toolbar-icons";
import { haptics, toolbarPress } from "@/haptics";
import { toast } from "@/components/Toast";
import { celebrateTaskDone, isDoneColumn } from "@/gamification/rewards";
import { formatDate } from "@cairn/shared/format/date";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/**
 * Task detail / editor. A leaf screen — it only navigates back — so both its
 * routes (root `app/card/[id]` and Projects-tab `app/(tabs)/projects/card/[id]`)
 * render it unchanged; the containing stack decides whether the tab bar shows.
 */
export function CardDetailScreen() {
  const { id, back } = useLocalSearchParams<{ id: string; back?: string }>();
  const router = useRouter();
  const t = useTheme();
  // Memoize the SQLite reads by their stable inputs so controlled-input edits
  // (title/description keystrokes) don't re-run the queries every render — and
  // so the `tags` memo below isn't invalidated by a fresh `card` object ref.
  const card = useMemo(() => (id ? getCard(id) : null), [id]);
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
  const columns: ColumnRow[] = useMemo(
    () => (card ? listColumns(card.project_id) : []),
    [card],
  );
  const tags = useMemo(() => (card ? tagsForCard({ tag_ids: JSON.stringify(tagIds) }) : []), [card, tagIds]);

  if (!card) {
    return <NotFound label="Task" />;
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
    if (columnId && columnId !== card.column_id) {
      // Celebrate if this save moves the card INTO a done column from a
      // non-done one (mirrors the board drag-to-done reward).
      const fromCol = columns.find((c) => c.id === card.column_id);
      const toCol = columns.find((c) => c.id === columnId);
      moveCardToColumn(card.id, columnId);
      if (isDoneColumn(toCol) && !isDoneColumn(fromCol)) {
        const doneColIds = new Set(columns.filter((c) => isDoneColumn(c)).map((c) => c.id));
        const remainingOpen = listCards(card.project_id).filter(
          (c) => c.id !== card.id && !doneColIds.has(c.column_id),
        ).length;
        celebrateTaskDone(remainingOpen);
      }
    }
    router.back();
  };

  const onArchive = () => {
    Alert.alert("Archive task?", "Archived tasks are removed from the board but kept in your data.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Archive",
        onPress: () => {
          haptics.warning();
          archiveCard(card.id);
          router.back();
        },
      },
    ]);
  };

  const onDelete = () => {
    Alert.alert("Delete task?", `"${card.title}" will be deleted. This can't be undone.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          haptics.impactHeavy();
          deleteCard(card.id);
          toast.success("Task deleted");
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
          // Root-stack pushes over the tab navigator can't infer the origin
          // tab's title (the back target is the whole `(tabs)` group), so
          // callers pass an explicit `back` label (Graph/Calendar/Search). The
          // in-tab Board flow omits it and gets iOS's default previous-title.
          ...(back ? { headerBackTitle: back } : {}),
        }}
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon={ICON_MORE} accessibilityLabel="Task actions">
          {/* Archive is recoverable, so it's NOT destructive — kept in the
              default colour to distinguish it from the red Delete below (the
              native iOS menu can't tint an action amber like the board zone). */}
          <Stack.Toolbar.MenuAction icon={ICON_ARCHIVE} onPress={toolbarPress(onArchive)}>
            Archive
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon={ICON_DELETE} destructive onPress={toolbarPress(onDelete)}>
            Delete
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.Button icon={ICON_CHECK} variant="done" accessibilityLabel="Save" onPress={toolbarPress(save, "confirm")}>
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
        <PriorityChips value={priority} onChange={setPriority} />

        {columns.length > 0 && (
          <>
            <Text style={styles.label}>Column</Text>
            <ColumnChips columns={columns} value={columnId} onChange={setColumnId} />
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
    label: { ...typeScale.overline, color: t.textTertiary, marginTop: 18, marginBottom: 8 },
    titleInput: { ...typeScale.title, color: t.textPrimary, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12 },
    placeholder: { ...typeScale.body, color: t.textTertiary, fontStyle: "italic" },
    dueRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    dueButton: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface },
    dueText: { ...typeScale.body, color: t.textPrimary, fontWeight: "500" },
    dueClear: { padding: 6 },
    assigneeInput: { ...typeScale.body, color: t.textPrimary, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12 },
    descInput: { ...typeScale.body, color: t.textPrimary, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12, minHeight: 160, fontFamily: "Menlo" },
    descHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 18, marginBottom: 8 },
    descToggle: { ...typeScale.label, color: t.accent },
    descPreview: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 4, minHeight: 160 },
  });
}
