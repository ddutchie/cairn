import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View, FlatList, Pressable, StyleSheet } from "react-native";
import { Stack, useRouter, useFocusEffect } from "expo-router";
import type { SearchBarCommands } from "react-native-screens";
import { searchNotes, searchTasks, type NoteRow, type CardRow } from "@/db/queries";
import { PressableScale } from "@/components/PressableScale";
import { TabScreen } from "@/components/TabScreen";
import { stripMarkdown } from "@cairn/shared/notes/text";
import { useTheme, elevation, PRIORITY_COLOR, type Theme } from "@/theme";

type Scope = "notes" | "tasks";

/**
 * Search screen using the native iOS search bar (headerSearchBarOptions) — the
 * platform UISearchController integrated into the large-title header. A
 * segmented control switches between searching notes and task cards; the query
 * re-runs against the active scope. Results render in a themed list below.
 */
export default function SearchScreen() {
  const router = useRouter();
  const t = useTheme();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("notes");
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [tasks, setTasks] = useState<CardRow[]>([]);
  const styles = useMemo(() => makeStyles(t), [t]);
  const searchRef = useRef<SearchBarCommands>(null);

  const run = useCallback((text: string, s: Scope) => {
    const q = text.trim();
    if (q.length === 0) {
      setNotes([]);
      setTasks([]);
      return;
    }
    if (s === "notes") setNotes(searchNotes(q));
    else setTasks(searchTasks(q));
  }, []);

  const onChange = (text: string) => {
    setQuery(text);
    run(text, scope);
  };

  const switchScope = (s: Scope) => {
    setScope(s);
    run(query, s);
  };

  // Focus the native search bar (and raise the keyboard) every time the tab is
  // opened — not just on first mount, since native tabs stay mounted. A short
  // delay lets the header search controller finish presenting first.
  useFocusEffect(
    useCallback(() => {
      const id = setTimeout(() => searchRef.current?.focus(), 350);
      return () => clearTimeout(id);
    }, []),
  );

  const hasQuery = query.trim().length > 0;

  return (
    <TabScreen>
      <Stack.Screen
        options={{
          title: "Search",
          headerSearchBarOptions: {
            ref: searchRef,
            placeholder: scope === "notes" ? "Search notes" : "Search tasks",
            autoCapitalize: "none",
            autoFocus: true,
            hideWhenScrolling: false,
            onChangeText: (e) => onChange(e.nativeEvent.text),
          },
        }}
      />
      <View style={styles.segment}>
        {(["notes", "tasks"] as Scope[]).map((s) => (
          <Pressable
            key={s}
            onPress={() => switchScope(s)}
            style={[styles.segmentBtn, scope === s && styles.segmentBtnActive]}
          >
            <Text style={[styles.segmentText, scope === s && styles.segmentTextActive]}>
              {s === "notes" ? "Notes" : "Tasks"}
            </Text>
          </Pressable>
        ))}
      </View>

      {scope === "notes" ? (
        <FlatList
          data={notes}
          keyExtractor={(n) => n.id}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={hasQuery ? <Text style={styles.hint}>No matching notes</Text> : null}
          renderItem={({ item }) => (
            <PressableScale style={[styles.row, elevation.sm]} onPress={() => router.push(`/note/${item.id}`)}>
              <Text style={styles.title} numberOfLines={1}>
                {item.title || "Untitled"}
              </Text>
              <Text style={styles.preview} numberOfLines={1}>
                {stripMarkdown(item.content ?? "")}
              </Text>
            </PressableScale>
          )}
        />
      ) : (
        <FlatList
          data={tasks}
          keyExtractor={(c) => c.id}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={hasQuery ? <Text style={styles.hint}>No matching tasks</Text> : null}
          renderItem={({ item }) => (
            <PressableScale style={[styles.row, elevation.sm]} onPress={() => router.push(`/card/${item.id}`)}>
              <View style={styles.taskTitleRow}>
                <View style={[styles.priorityDot, { backgroundColor: PRIORITY_COLOR[item.priority as keyof typeof PRIORITY_COLOR] ?? t.textTertiary }]} />
                <Text style={styles.title} numberOfLines={1}>
                  {item.title || "Untitled"}
                </Text>
              </View>
              {item.description ? (
                <Text style={styles.preview} numberOfLines={1}>
                  {stripMarkdown(item.description)}
                </Text>
              ) : null}
            </PressableScale>
          )}
        />
      )}
    </TabScreen>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    segment: {
      flexDirection: "row",
      gap: 4,
      margin: 12,
      marginBottom: 0,
      padding: 3,
      backgroundColor: t.surface,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border,
    },
    segmentBtn: { flex: 1, paddingVertical: 7, borderRadius: 7, alignItems: "center" },
    segmentBtnActive: { backgroundColor: t.accent },
    segmentText: { fontSize: 14, fontWeight: "600", color: t.textSecondary },
    segmentTextActive: { color: t.accentFg },
    list: { padding: 12 },
    row: {
      paddingVertical: 10,
      paddingHorizontal: 14,
      marginBottom: 8,
      backgroundColor: t.surface,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border,
    },
    taskTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    priorityDot: { width: 8, height: 8, borderRadius: 4 },
    title: { fontSize: 15, fontWeight: "600", color: t.textPrimary, flexShrink: 1 },
    preview: { fontSize: 13, color: t.textSecondary, marginTop: 2 },
    hint: { textAlign: "center", color: t.textTertiary, marginTop: 24 },
  });
}
