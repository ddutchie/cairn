import { useCallback, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { useFocusEffect } from "expo-router";
import { listProjects, listColumns, listCards, type ProjectRow } from "@/db/queries";

const PRIORITY_COLOR: Record<string, string> = {
  low: "#94a3b8",
  medium: "#6366f1",
  high: "#f59e0b",
  urgent: "#ef4444",
};

export default function BoardScreen() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);

  const load = useCallback(() => {
    const ps = listProjects();
    setProjects(ps);
    setActiveProject((cur) => cur ?? ps[0]?.id ?? null);
  }, []);

  useFocusEffect(useCallback(() => load(), [load]));

  if (projects.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyHint}>No projects yet. Import a desktop oplog from the Sync tab.</Text>
      </View>
    );
  }

  const columns = activeProject ? listColumns(activeProject) : [];
  const cards = activeProject ? listCards(activeProject) : [];

  return (
    <View style={styles.container}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.projectBar} contentContainerStyle={styles.projectBarInner}>
        {projects.map((p) => (
          <Pressable
            key={p.id}
            onPress={() => setActiveProject(p.id)}
            style={[styles.chip, activeProject === p.id && styles.chipActive]}
          >
            <Text style={[styles.chipText, activeProject === p.id && styles.chipTextActive]}>{p.name}</Text>
          </Pressable>
        ))}
      </ScrollView>

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
                  <View style={[styles.priorityDot, { backgroundColor: PRIORITY_COLOR[card.priority] ?? "#6366f1" }]} />
                  <Text style={styles.cardTitle}>{card.title}</Text>
                </View>
              ))}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f8f8f8" },
  projectBar: { maxHeight: 52, borderBottomWidth: 1, borderBottomColor: "#eee", backgroundColor: "#fff" },
  projectBarInner: { padding: 10, gap: 8, flexDirection: "row" },
  chip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, backgroundColor: "#f0f0f0" },
  chipActive: { backgroundColor: "#6366f1" },
  chipText: { color: "#444", fontSize: 13 },
  chipTextActive: { color: "#fff", fontWeight: "600" },
  board: { padding: 12, gap: 12, flexDirection: "row", alignItems: "flex-start" },
  column: { width: 240, backgroundColor: "#fff", borderRadius: 12, padding: 10, borderWidth: 1, borderColor: "#eee" },
  columnTitle: { fontSize: 14, fontWeight: "700", color: "#333", marginBottom: 8 },
  count: { color: "#aaa", fontWeight: "400" },
  card: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#fafafa", borderRadius: 8, padding: 10, marginBottom: 8, borderWidth: 1, borderColor: "#f0f0f0" },
  priorityDot: { width: 8, height: 8, borderRadius: 4 },
  cardTitle: { flex: 1, fontSize: 13, color: "#222" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  emptyHint: { fontSize: 13, color: "#888", textAlign: "center" },
});
