import { useMemo, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, KeyboardAvoidingView, Platform, Alert } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { MoreHorizontal } from "lucide-react-native";
import { getCard, listColumns, updateTask, moveCardToColumn, archiveCard, tagsForCard, type ColumnRow } from "@/db/queries";
import { TagChips } from "@/components/TagChips";
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
  const columns: ColumnRow[] = card ? listColumns(card.project_id) : [];
  const tags = card ? tagsForCard(card) : [];

  if (!card) {
    return (
      <View style={styles.center}>
        <Text style={styles.missing}>Task not found</Text>
      </View>
    );
  }

  const save = () => {
    updateTask(card.id, { title: title.trim() || "Untitled", description, priority });
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
          headerRight: () => (
            <View style={styles.headerActions}>
              <Pressable onPress={save} hitSlop={12}>
                <Text style={styles.save}>Save</Text>
              </Pressable>
              <Pressable onPress={onArchive} hitSlop={12}>
                <MoreHorizontal size={22} color={t.accent} />
              </Pressable>
            </View>
          ),
        }}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Title</Text>
        <TextInput style={styles.titleInput} value={title} onChangeText={setTitle} placeholder="Task title" placeholderTextColor={t.textTertiary} multiline />

        {tags.length > 0 && (
          <>
            <Text style={styles.label}>Tags</Text>
            <TagChips tags={tags} />
          </>
        )}

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
    priorityRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
    priorityChip: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1 },
    priorityText: { fontSize: 13, fontWeight: "600", textTransform: "capitalize" },
    columnRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
    columnChip: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1 },
    descInput: { fontSize: 15, lineHeight: 22, color: t.textPrimary, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12, minHeight: 160, fontFamily: "Menlo" },
    save: { color: t.accent, fontSize: 16, fontWeight: "600" },
    headerActions: { flexDirection: "row", alignItems: "center", gap: 16 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.background },
    missing: { color: t.textTertiary },
  });
}
