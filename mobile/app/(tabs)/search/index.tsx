import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View, FlatList, StyleSheet } from "react-native";
import { Stack, useRouter, useFocusEffect } from "expo-router";
import type { SearchBarCommands } from "react-native-screens";
import { searchNotes, searchTasks, listWorkspaceIds, type NoteRow, type CardRow } from "@/db/queries";
import { PressableScale } from "@/components/PressableScale";
import { TabScreen } from "@/components/TabScreen";
import { IndexingBar } from "@/components/IndexingBar";
import { ICON_NOTE, ICON_TASK, ICON_SEMANTIC } from "@/components/toolbar-icons";
import { semanticSearch, catchUpIndex, type SemanticHit } from "@/notes/embeddings";
import { isAppleEmbeddingsSupported, appleEmbeddingsUnavailableReason } from "@modules/apple-embeddings";
import { stripMarkdown } from "@cairn/shared/notes/text";
import { useTheme, elevation, PRIORITY_COLOR, type as typeScale, type Theme } from "@/theme";

type Scope = "notes" | "tasks" | "semantic";

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
  const [hits, setHits] = useState<SemanticHit[]>([]);
  const styles = useMemo(() => makeStyles(t), [t]);
  const searchRef = useRef<SearchBarCommands>(null);
  const semanticAvailable = isAppleEmbeddingsSupported();
  // Monotonic token so a slow semantic query can't overwrite a newer one.
  const semanticSeq = useRef(0);

  const run = useCallback((text: string, s: Scope) => {
    const q = text.trim();
    if (q.length === 0) {
      setNotes([]);
      setTasks([]);
      setHits([]);
      return;
    }
    if (s === "notes") setNotes(searchNotes(q));
    else if (s === "tasks") setTasks(searchTasks(q));
    else {
      // Semantic: embed the query and cosine-rank across all workspaces.
      const seq = ++semanticSeq.current;
      (async () => {
        const all: SemanticHit[] = [];
        for (const ws of listWorkspaceIds()) all.push(...(await semanticSearch(ws, q, 20)));
        all.sort((a, b) => b.score - a.score);
        if (seq === semanticSeq.current) setHits(all.slice(0, 30));
      })();
    }
  }, []);

  // Debounce search-as-you-type so a burst of keystrokes fires one SQLite query
  // after input settles, not one per character.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runDebounced = useCallback(
    (text: string, s: Scope) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => run(text, s), 200);
    },
    [run],
  );

  const onChange = (text: string) => {
    setQuery(text);
    runDebounced(text, scope);
  };

  const switchScope = (s: Scope) => {
    setScope(s);
    // Selecting Semantic ensures the on-device index is built (downloads model
    // assets on first use + embeds any not-yet-indexed notes). The IndexingBar
    // shows progress; re-run the query when it finishes so results appear.
    if (s === "semantic") {
      catchUpIndex()
        .then(() => run(query, "semantic"))
        .catch(() => {});
    }
    // Scope changes are deliberate (not rapid) — run immediately, and cancel any
    // pending debounced query so it can't overwrite this with the old scope.
    if (debounceRef.current) clearTimeout(debounceRef.current);
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
  // Always show the Semantic scope so it's discoverable; if on-device
  // embeddings aren't usable we explain why in the results area rather than
  // silently hiding the option.
  const scopes: Scope[] = ["notes", "tasks", "semantic"];
  const scopeLabel = (s: Scope) => (s === "notes" ? "Notes" : s === "tasks" ? "Tasks" : "Semantic");
  const scopeIcon = (s: Scope) => (s === "notes" ? ICON_NOTE : s === "tasks" ? ICON_TASK : ICON_SEMANTIC);
  const placeholder =
    scope === "notes" ? "Search notes" : scope === "tasks" ? "Search tasks" : "Search notes by meaning";

  return (
    <TabScreen>
      <Stack.Screen
        options={{
          title: "Search",
          headerSearchBarOptions: {
            ref: searchRef,
            placeholder,
            autoCapitalize: "none",
            autoFocus: true,
            hideWhenScrolling: false,
            onChangeText: (e) => onChange(e.nativeEvent.text),
          },
        }}
      />
      {/* Scope switch lives in the native toolbar (not an in-body segment):
          the search tab's native search field owns the header area, so a
          floating menu reads correctly and can't be clipped by content insets. */}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon={scopeIcon(scope)} accessibilityLabel="Search scope">
          <Stack.Toolbar.Label>{scopeLabel(scope)}</Stack.Toolbar.Label>
          {scopes.map((s) => (
            <Stack.Toolbar.MenuAction
              key={s}
              icon={scopeIcon(s)}
              isOn={scope === s}
              onPress={() => switchScope(s)}
            >
              {scopeLabel(s)}
            </Stack.Toolbar.MenuAction>
          ))}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      {/* Live progress while the on-device semantic index catches up. */}
      <IndexingBar />

      {scope === "semantic" ? (
        <FlatList
          data={hits}
          keyExtractor={(h) => h.noteId}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            !semanticAvailable ? (
              <Text style={styles.hint}>{appleEmbeddingsUnavailableReason()}</Text>
            ) : hasQuery ? (
              <Text style={styles.hint}>No semantically similar notes</Text>
            ) : (
              <Text style={styles.hint}>Search your notes by meaning, not just keywords.</Text>
            )
          }
          renderItem={({ item }) => (
            <PressableScale style={[styles.row, elevation.sm]} onPress={() => router.push({ pathname: "/note/[id]", params: { id: item.noteId, back: "Search" } })}>
              <View style={styles.taskTitleRow}>
                <Text style={styles.title} numberOfLines={1}>
                  {item.title || "Untitled"}
                </Text>
                <Text style={styles.score}>{Math.round(item.score * 100)}%</Text>
              </View>
              {item.sectionTitle ? (
                <Text style={styles.preview} numberOfLines={1}>
                  {item.sectionTitle}
                </Text>
              ) : null}
            </PressableScale>
          )}
        />
      ) : scope === "notes" ? (
        <FlatList
          data={notes}
          keyExtractor={(n) => n.id}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={hasQuery ? <Text style={styles.hint}>No matching notes</Text> : null}
          renderItem={({ item }) => (
            <PressableScale style={[styles.row, elevation.sm]} onPress={() => router.push({ pathname: "/note/[id]", params: { id: item.id, back: "Search" } })}>
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
            <PressableScale style={[styles.row, elevation.sm]} onPress={() => router.push({ pathname: "/card/[id]", params: { id: item.id, back: "Search" } })}>
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
    title: { ...typeScale.control, color: t.textPrimary, flexShrink: 1 },
    preview: { ...typeScale.caption, color: t.textSecondary, marginTop: 2 },
    score: { ...typeScale.caption, color: t.textTertiary, marginLeft: "auto", fontVariant: ["tabular-nums"] },
    hint: { textAlign: "center", color: t.textTertiary, marginTop: 24 },
  });
}
