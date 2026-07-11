import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View, FlatList, StyleSheet, RefreshControl, Pressable, Alert, Keyboard, useWindowDimensions } from "react-native";
import { Stack, useRouter, useFocusEffect, type Href } from "expo-router";
import type { SearchBarCommands } from "react-native-screens";
import { searchNotes, searchTasks, listWorkspaceIds, embeddingIndexStats, type NoteRow, type CardRow } from "@/db/queries";
import { ResultRow } from "@/components/ResultRow";
import { TabScreen } from "@/components/TabScreen";
import { EmptyState } from "@/components/EmptyState";
import { IndexingBar } from "@/components/IndexingBar";
import { GlassBar, glassActive } from "@/components/GlassBar";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { semanticSearch, catchUpIndex, type SemanticHit } from "@/notes/embeddings";
import { haptics } from "@/haptics";
import { isAppleEmbeddingsSupported, appleEmbeddingsUnavailableReason } from "@modules/apple-embeddings";
import { stripMarkdown } from "@cairn/shared/notes/text";
import { useTheme, PRIORITY_COLOR, TAB_BAR_BASE, hasTabBarSearchField, tabBarClosedLift, KEYBOARD_OPEN_GAP, type as typeScale, type Theme } from "@/theme";

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
  const { height: screenH } = useWindowDimensions();
  // Match the chat empty state's icon position exactly. Chat's ScrollView fills
  // the screen and its EmptyState biases 25% down, so its icon lands ~25.7% of
  // the screen height from the top. Search's FlatList content box isn't the full
  // screen height on iOS 27 (the search header/insets shrink it), so a relative
  // 25% would land too high (behind the header). Anchor from the SCREEN TOP with
  // the same fraction instead, so both screens match on any device.
  const emptyTop = screenH * 0.257;
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
      // Semantic: embed the query and rank across all workspaces. Gather the
      // FULL ranked candidate list per workspace, then sort by the hybrid `rank`
      // (dense+lexical) and slice ONCE — slicing per workspace would drop a note
      // that ranks low in its workspace but high globally. Rank by `rank`, NOT
      // the displayed `score` (raw cosine), which reintroduces the buried-note bug.
      const seq = ++semanticSeq.current;
      (async () => {
        const all: SemanticHit[] = [];
        for (const ws of listWorkspaceIds()) all.push(...(await semanticSearch(ws, q)));
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
    if (s !== scope) haptics.selection();
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
  // Whether the active scope's list has zero rows (drives the empty-state layout:
  // no results padding, no scrolling).
  const isListEmpty = (scope === "semantic" ? hits : scope === "notes" ? notes : tasks).length === 0;
  // Always show the Semantic scope so it's discoverable; if on-device
  // embeddings aren't usable we explain why in the results area rather than
  // silently hiding the option.
  const scopes: Scope[] = ["notes", "tasks", "semantic"];
  const scopeLabel = (s: Scope) => (s === "notes" ? "Notes" : s === "tasks" ? "Tasks" : "Semantic");
  const placeholder =
    scope === "notes" ? "Search notes" : scope === "tasks" ? "Search tasks" : "Search notes by meaning";

  // Primary + secondary hint lines for the empty state (ListEmptyComponent).
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
  // Empty/hint state rendered INSIDE the list (as ListEmptyComponent) so it
  // sits below the native search header — an absolute screen overlay would
  // render behind it. With no query it's the branded resting state; during an
  // active search with no matches it's a light top-anchored text hint.
  const listEmpty = hasQuery ? (
    <View style={[styles.emptyHint, { paddingTop: emptyTop }]} pointerEvents="none">
      <Text style={styles.hint}>{emptyHint.primary}</Text>
      {emptyHint.secondary ? <Text style={styles.statHint}>{emptyHint.secondary}</Text> : null}
    </View>
  ) : (
    // topBias = screen-top-relative position matching chat's icon (~25.7% down),
    // since the search list frame isn't the full screen on iOS 27.
    <EmptyState title={emptyHint.primary} subtitle={emptyHint.secondary} align="top" topBias={emptyTop} />
  );

  const listProps = {
    // Empty state: use flexGrow-only (no results padding) so the content is
    // exactly the viewport height and the screen doesn't scroll. With results:
    // apply the list padding that clears the scope bar / tab bar / keyboard.
    contentContainerStyle: isListEmpty ? styles.listGrow : styles.list,
    // Nothing to scroll when empty — also stops the anchored empty state from
    // being draggable past the header.
    scrollEnabled: !isListEmpty,
    contentInsetAdjustmentBehavior: "automatic" as const,
    keyboardShouldPersistTaps: "handled" as const,
    keyboardDismissMode: "on-drag" as const,
    ListHeaderComponent: <IndexingBar />,
    ListEmptyComponent: listEmpty,
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
            <ResultRow
              title={item.title}
              preview={item.sectionTitle}
              score={item.rank}
              onPress={() => openResult({ pathname: "/note/[id]", params: { id: item.noteId, back: "Search" } })}
            />
          )}
        />
      ) : scope === "notes" ? (
        <FlatList
          data={notes}
          keyExtractor={(n) => n.id}
          {...listProps}
          renderItem={({ item }) => (
            <ResultRow
              title={item.title}
              preview={stripMarkdown(item.content ?? "")}
              onPress={() => openResult({ pathname: "/note/[id]", params: { id: item.id, back: "Search" } })}
            />
          )}
        />
      ) : (
        <FlatList
          data={tasks}
          keyExtractor={(c) => c.id}
          {...listProps}
          renderItem={({ item }) => (
            <ResultRow
              title={item.title}
              preview={item.description ? stripMarkdown(item.description) : null}
              dotColor={PRIORITY_COLOR[item.priority as keyof typeof PRIORITY_COLOR] ?? t.textTertiary}
              onPress={() => openResult({ pathname: "/card/[id]", params: { id: item.id, back: "Search" } })}
            />
          )}
        />
      )}

      {/* Persistent scope switch, pinned to the bottom. On iOS ≤26 the tab-bar
          search field docks above the keyboard, so we clear it (SEARCH_FIELD_H)
          when open and rest on insets.bottom when closed. On iOS 27 there's no
          tab-bar search field (see hasTabBarSearchField), so it matches the chat
          composer exactly: rest above the tab bar (tabBarClosedLift) when closed,
          and clear the keyboard by KEYBOARD_OPEN_GAP when open. */}
      <KeyboardStickyView
        offset={{
          closed: hasTabBarSearchField ? -insets.bottom : -tabBarClosedLift(insets.bottom),
          opened: hasTabBarSearchField ? -(SEARCH_FIELD_H + SCOPE_GAP) : -KEYBOARD_OPEN_GAP,
        }}
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
    // Bottom pad clears the pinned scope bar + tab bar (+ the native search
    // field on iOS ≤26; none on iOS 27, so drop that reservation).
    list: { padding: 12, paddingBottom: 12 + TAB_BAR_BASE + (hasTabBarSearchField ? SEARCH_FIELD_H : 0) + 48 },
    // Lets ListEmptyComponent fill the viewport so the branded state's top-bias
    // is measured against the full content area (below the header).
    listGrow: { flexGrow: 1 },
    // Active-search "no matches" hint — paddingTop supplied inline (emptyTop) so
    // it matches the branded state and clears the header / keyboard.
    emptyHint: { flex: 1, alignItems: "center", paddingHorizontal: 32 },
    hint: { textAlign: "center", color: t.textTertiary },
    statHint: { ...typeScale.caption, textAlign: "center", color: t.textTertiary, marginTop: 8 },
  });
}
