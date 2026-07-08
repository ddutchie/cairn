import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View, FlatList, StyleSheet, RefreshControl, Pressable, Alert, Keyboard } from "react-native";
import { Stack, useRouter, useFocusEffect, type Href } from "expo-router";
import type { SearchBarCommands } from "react-native-screens";
import { searchNotes, searchTasks, listWorkspaceIds, embeddingIndexStats, type NoteRow, type CardRow } from "@/db/queries";
import { PressableScale } from "@/components/PressableScale";
import { TabScreen } from "@/components/TabScreen";
import { IndexingBar } from "@/components/IndexingBar";
import { GlassBar, glassActive } from "@/components/GlassBar";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { semanticSearch, catchUpIndex, type SemanticHit } from "@/notes/embeddings";
import { isAppleEmbeddingsSupported, appleEmbeddingsUnavailableReason } from "@modules/apple-embeddings";
import { stripMarkdown } from "@cairn/shared/notes/text";
import { useTheme, elevation, PRIORITY_COLOR, TAB_BAR_BASE, type as typeScale, type Theme } from "@/theme";

type Scope = "notes" | "tasks" | "semantic";

// Approx height of the native iOS 26 tab-bar search field (used to lift the
// scope bar clear of it, both docked-on-keyboard and resting above the tab bar).
const SEARCH_FIELD_H = 52;
// Breathing room between the scope bar and the search field.
const SCOPE_GAP = 8;

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
  const [reindexing, setReindexing] = useState(false);
  const [stats, setStats] = useState<{ liveNotes: number; indexedNotes: number } | null>(null);
  const styles = useMemo(() => makeStyles(t), [t]);
  const searchRef = useRef<SearchBarCommands>(null);
  const insets = useSafeAreaInsets();
  const semanticAvailable = isAppleEmbeddingsSupported();
  // Monotonic token so a slow semantic query can't overwrite a newer one.
  const semanticSeq = useRef(0);

  const run = useCallback((text: string, s: Scope) => {
    const q = text.trim();
    if (q.length === 0) {
      // Invalidate any in-flight semantic query so a slow result can't
      // repopulate hits after we clear them here.
      semanticSeq.current++;
      setNotes([]);
      setTasks([]);
      setHits([]);
      return;
    }
    if (s === "notes") setNotes(searchNotes(q));
    else if (s === "tasks") setTasks(searchTasks(q));
    else {
      // Semantic: embed the query and rank across all workspaces. Sort by the
      // hybrid `rank` (dense+lexical), NOT the displayed `score` (raw cosine) —
      // ranking by score alone reintroduces the "correct note buried" bug.
      const seq = ++semanticSeq.current;
      (async () => {
        const all: SemanticHit[] = [];
        for (const ws of listWorkspaceIds()) all.push(...(await semanticSearch(ws, q, 20)));
        all.sort((a, b) => b.rank - a.rank);
        if (seq === semanticSeq.current) setHits(all.slice(0, 30));
      })().catch((e) => console.warn("[search] semantic search failed:", e));
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

  // Navigate to a result, dismissing the keyboard + blurring the native search
  // bar FIRST. Leaving the search bar focused while pushing a detail screen
  // makes it re-present its focused/keyboard state on return, so the header
  // animates open → snaps closed → reopens (the visible jump). Blurring before
  // the push means the header is already at rest when we come back.
  const openResult = useCallback(
    (href: Href) => {
      searchRef.current?.blur();
      Keyboard.dismiss();
      router.push(href);
    },
    [router],
  );

  // Recompute index stats (indexed vs total notes) across all workspaces.
  const refreshStats = useCallback(() => {
    let live = 0;
    let indexed = 0;
    for (const ws of listWorkspaceIds()) {
      const s = embeddingIndexStats(ws);
      live += s.liveNotes;
      indexed += s.indexedNotes;
    }
    setStats({ liveNotes: live, indexedNotes: indexed });
  }, []);

  // Pull-to-refresh on the Semantic list: force a full catch-up (embeds any
  // not-yet-indexed notes — e.g. ones just synced from desktop), then re-run
  // the query + refresh the stats readout.
  const forceReindex = useCallback(async () => {
    setReindexing(true);
    try {
      await catchUpIndex();
      refreshStats();
      run(query, "semantic");
    } catch (e) {
      console.warn("[search] reindex failed:", e);
      Alert.alert("Reindex failed", "Couldn't finish indexing notes for semantic search. Pull to try again.");
    } finally {
      setReindexing(false);
    }
  }, [query, run, refreshStats]);

  // Refresh stats whenever the Semantic scope is shown or the tab regains focus.
  useFocusEffect(
    useCallback(() => {
      if (scope === "semantic") refreshStats();
    }, [scope, refreshStats]),
  );

  const hasQuery = query.trim().length > 0;
  // Always show the Semantic scope so it's discoverable; if on-device
  // embeddings aren't usable we explain why in the results area rather than
  // silently hiding the option.
  const scopes: Scope[] = ["notes", "tasks", "semantic"];
  const scopeLabel = (s: Scope) => (s === "notes" ? "Notes" : s === "tasks" ? "Tasks" : "Semantic");
  const placeholder =
    scope === "notes" ? "Search notes" : scope === "tasks" ? "Search tasks" : "Search notes by meaning";

  // Which list is active + whether it's empty (drives the centred overlay hint).
  const activeCount = scope === "notes" ? notes.length : scope === "tasks" ? tasks.length : hits.length;
  const showEmpty = activeCount === 0;
  // Primary + secondary hint lines for the centred empty state.
  const emptyHint: { primary: string; secondary?: string } = (() => {
    if (scope === "semantic") {
      if (!semanticAvailable) return { primary: appleEmbeddingsUnavailableReason() };
      if (hasQuery) return { primary: "No semantically similar notes" };
      return {
        primary: "Search your notes by meaning, not just keywords.",
        secondary: stats
          ? `${stats.indexedNotes} of ${stats.liveNotes} notes indexed${stats.indexedNotes < stats.liveNotes ? " · pull down to finish indexing" : ""}`
          : undefined,
      };
    }
    if (scope === "notes") {
      return { primary: hasQuery ? "No matching notes" : "Search notes by title and content." };
    }
    return { primary: hasQuery ? "No matching tasks" : "Search tasks by title and description." };
  })();

  // Shared list scrolling behaviour. `contentInsetAdjustmentBehavior="automatic"`
  // makes the list clear the native search header (top). The bottom pad in
  // `styles.list` already clears the keyboard/scope-bar/tab-bar area, so we do
  // NOT set `automaticallyAdjustKeyboardInsets` — combined with the automatic
  // top inset it miscalculates the content offset when the keyboard opens and
  // scrolls the first result up under the header. IndexingBar rides as the list
  // header so the FlatList stays the screen's first (and only) scroll view —
  // required for iOS to apply the automatic search-header inset.
  const listProps = {
    contentContainerStyle: styles.list,
    contentInsetAdjustmentBehavior: "automatic" as const,
    keyboardShouldPersistTaps: "handled" as const,
    keyboardDismissMode: "on-drag" as const,
    ListHeaderComponent: <IndexingBar />,
  };

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

      {scope === "semantic" ? (
        <FlatList
          data={hits}
          keyExtractor={(h) => h.noteId}
          {...listProps}
          refreshControl={
            semanticAvailable ? (
              <RefreshControl refreshing={reindexing} onRefresh={forceReindex} tintColor={t.textTertiary} />
            ) : undefined
          }
          renderItem={({ item }) => (
            <PressableScale style={[styles.row, elevation.sm]} onPress={() => openResult({ pathname: "/note/[id]", params: { id: item.noteId, back: "Search" } })}>
              <View style={styles.taskTitleRow}>
                <Text style={styles.title} numberOfLines={1}>
                  {item.title || "Untitled"}
                </Text>
                <Text style={styles.score}>{Math.round(item.rank * 100)}%</Text>
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
          {...listProps}
          renderItem={({ item }) => (
            <PressableScale style={[styles.row, elevation.sm]} onPress={() => openResult({ pathname: "/note/[id]", params: { id: item.id, back: "Search" } })}>
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
          {...listProps}
          renderItem={({ item }) => (
            <PressableScale style={[styles.row, elevation.sm]} onPress={() => openResult({ pathname: "/card/[id]", params: { id: item.id, back: "Search" } })}>
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

      {/* Centred empty/hint overlay — absolutely positioned over the list area so
          it stays put (doesn't jump with the keyboard, doesn't hide behind the
          header the way a list-top ListEmptyComponent does). */}
      {showEmpty ? (
        <View style={styles.emptyOverlay} pointerEvents="none">
          <Text style={styles.hint}>{emptyHint.primary}</Text>
          {emptyHint.secondary ? <Text style={styles.statHint}>{emptyHint.secondary}</Text> : null}
        </View>
      ) : null}

      {/* Persistent scope switch, pinned to the bottom just above the native
          search field. With the iOS 26 search tab the search field lives at the
          bottom (above the keyboard), so the toggle rides the keyboard via
          KeyboardStickyView: when closed it sits above the tab-bar search field;
          when open it lifts to clear the field that's now docked on the keyboard. */}
      <KeyboardStickyView
        offset={{ closed: -insets.bottom, opened: -(SEARCH_FIELD_H + SCOPE_GAP) }}
        style={styles.scopeOverlay}
      >
        <GlassBar style={[styles.scopeBar, !glassActive && styles.scopeBarFallback]}>
          {scopes.map((s) => (
            <Pressable
              key={s}
              onPress={() => switchScope(s)}
              style={[styles.scopeBtn, scope === s && styles.scopeBtnActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: scope === s }}
            >
              <Text style={[styles.scopeText, scope === s && styles.scopeTextActive]}>
                {scopeLabel(s)}
              </Text>
            </Pressable>
          ))}
        </GlassBar>
      </KeyboardStickyView>
    </TabScreen>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    scopeOverlay: { position: "absolute", left: 12, right: 12, bottom: 0 },
    scopeBar: {
      flexDirection: "row",
      gap: 4,
      padding: 4,
      borderRadius: 12,
      overflow: "hidden",
    },
    // Fallback (no Liquid Glass): give the bar a solid themed surface + border.
    scopeBarFallback: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border },
    scopeBtn: { flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: "center" },
    scopeBtnActive: { backgroundColor: t.accent },
    scopeText: { ...typeScale.control, color: t.textSecondary },
    scopeTextActive: { color: t.accentFg },
    // Bottom pad clears the pinned scope bar + the native search field + tab bar
    // so the last result is scrollable into view above them.
    list: { padding: 12, paddingBottom: 12 + TAB_BAR_BASE + SEARCH_FIELD_H + 48 },
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
    emptyOverlay: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      // Anchor the hint at ~25% from the top (75% from the bottom) so it stays
      // clear of the keyboard/scope bar rather than being hidden behind them.
      bottom: "75%",
      alignItems: "center",
      justifyContent: "flex-end",
      paddingHorizontal: 32,
    },
    hint: { textAlign: "center", color: t.textTertiary },
    statHint: { ...typeScale.caption, textAlign: "center", color: t.textTertiary, marginTop: 8 },
  });
}
