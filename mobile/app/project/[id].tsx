import { useCallback, useMemo, useState } from "react";
import { View, Text, SectionList, ScrollView, Pressable, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter, useFocusEffect, Stack } from "expo-router";
import {
  getProject,
  listNotes,
  listColumns,
  listCards,
  type NoteRow,
  type CardRow,
  type ColumnRow,
} from "@/db/queries";
import { useTheme, PRIORITY_COLOR, type Theme } from "@/theme";

type Tab = "notes" | "board";

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const t = useTheme();
  const [tab, setTab] = useState<Tab>("notes");
  const [project, setProject] = useState(id ? getProject(id) : null);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [columns, setColumns] = useState<ColumnRow[]>([]);
  const [cards, setCards] = useState<CardRow[]>([]);

  const load = useCallback(() => {
    if (!id) return;
    setProject(getProject(id));
    setNotes(listNotes(id));
    setColumns(listColumns(id));
    setCards(listCards(id));
  }, [id]);

  useFocusEffect(useCallback(() => load(), [load]));

  // Group notes by folder for a SectionList (folder header = section title).
  const sections = useMemo(() => {
    const byFolder = new Map<string, NoteRow[]>();
    for (const n of notes) {
      const f = n.folder || "";
      if (!byFolder.has(f)) byFolder.set(f, []);
      byFolder.get(f)!.push(n);
    }
    return [...byFolder.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([folder, data]) => ({ title: folder || "(root)", data }));
  }, [notes]);

  const styles = useMemo(() => makeStyles(t), [t]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: project?.name || "Project" }} />

      {/* Segmented control */}
      <View style={styles.segment}>
        <Segment label="Notes" active={tab === "notes"} onPress={() => setTab("notes")} t={t} />
        <Segment label="Board" active={tab === "board"} onPress={() => setTab("board")} t={t} />
      </View>

      {tab === "notes" ? (
        notes.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyHint}>No notes in this project.</Text>
          </View>
        ) : (
          <SectionList
            sections={sections}
            keyExtractor={(n) => n.id}
            contentContainerStyle={styles.list}
            stickySectionHeadersEnabled={false}
            renderSectionHeader={({ section }) =>
              sections.length > 1 || section.title !== "(root)" ? (
                <Text style={styles.folderHeader}>{section.title}</Text>
              ) : null
            }
            renderItem={({ item }) => (
              <Pressable style={styles.noteRow} onPress={() => router.push(`/note/${item.id}`)}>
                <Text style={styles.noteTitle} numberOfLines={1}>
                  {item.title || "Untitled"}
                </Text>
                <Text style={styles.notePreview} numberOfLines={2}>
                  {(item.content ?? "").replace(/[#*_`>[\]()!-]/g, "").trim()}
                </Text>
              </Pressable>
            )}
          />
        )
      ) : (
        <BoardView columns={columns} cards={cards} t={t} styles={styles} />
      )}
    </View>
  );
}

function Segment({ label, active, onPress, t }: { label: string; active: boolean; onPress: () => void; t: Theme }) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center" },
        active && { backgroundColor: t.surface },
      ]}
    >
      <Text style={{ color: active ? t.textPrimary : t.textTertiary, fontWeight: active ? "600" : "400", fontSize: 14 }}>
        {label}
      </Text>
    </Pressable>
  );
}

function BoardView({ columns, cards, t, styles }: { columns: ColumnRow[]; cards: CardRow[]; t: Theme; styles: ReturnType<typeof makeStyles> }) {
  if (columns.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyHint}>No board columns in this project.</Text>
      </View>
    );
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.board}>
      {columns.map((col) => {
        const colCards = cards.filter((c) => c.column_id === col.id);
        return (
          <View key={col.id} style={styles.column}>
            <Text style={styles.columnTitle}>
              {col.name} <Text style={styles.count}>{colCards.length}</Text>
            </Text>
            {colCards.map((card) => (
              <View key={card.id} style={styles.card}>
                <View style={[styles.priorityDot, { backgroundColor: PRIORITY_COLOR[card.priority] ?? t.accent }]} />
                <Text style={styles.cardTitle}>{card.title}</Text>
              </View>
            ))}
          </View>
        );
      })}
    </ScrollView>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.background },
    segment: {
      flexDirection: "row",
      gap: 4,
      margin: 12,
      padding: 4,
      backgroundColor: t.surface2,
      borderRadius: 10,
    },
    list: { padding: 12, paddingTop: 0 },
    folderHeader: {
      fontSize: 12,
      fontWeight: "700",
      color: t.textTertiary,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginTop: 14,
      marginBottom: 6,
    },
    noteRow: {
      paddingVertical: 12,
      paddingHorizontal: 14,
      marginBottom: 8,
      backgroundColor: t.surface,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border,
    },
    noteTitle: { fontSize: 16, fontWeight: "600", color: t.textPrimary },
    notePreview: { fontSize: 13, color: t.textSecondary, marginTop: 4 },
    board: { padding: 12, paddingTop: 0, gap: 12, flexDirection: "row", alignItems: "flex-start" },
    column: { width: 250, backgroundColor: t.surface, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: t.border },
    columnTitle: { fontSize: 14, fontWeight: "700", color: t.textPrimary, marginBottom: 8 },
    count: { color: t.textTertiary, fontWeight: "400" },
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: t.surface2,
      borderRadius: 8,
      padding: 10,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: t.borderSubtle,
    },
    priorityDot: { width: 8, height: 8, borderRadius: 4 },
    cardTitle: { flex: 1, fontSize: 13, color: t.textPrimary },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
    emptyHint: { fontSize: 13, color: t.textTertiary, textAlign: "center" },
  });
}
