import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View, FlatList, StyleSheet, RefreshControl, Pressable, Alert, Keyboard, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Stack, useRouter, useFocusEffect, type Href } from "expo-router";
import type { SearchBarCommands } from "react-native-screens";
import { searchNotes, searchTasks, listWorkspaceIds, embeddingIndexStats, listUnindexedNotes, listUnindexedCards, type NoteRow, type CardRow, type UnindexedNote } from "@/db/queries";
import { ResultRow } from "@/components/ResultRow";
import { TabScreen } from "@/components/TabScreen";
import { EmptyState } from "@/components/EmptyState";
import { IndexingBar } from "@/components/IndexingBar";
import SegmentedControl from "@react-native-segmented-control/segmented-control";
import { Sparkles, Info } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { semanticSearch, semanticSearchTasks, catchUpIndex, finalizeRanking, type SemanticHit } from "@/notes/embeddings";
import { haptics } from "@/haptics";
import { isAppleEmbeddingsSupported, appleEmbeddingsUnavailableReason } from "@modules/apple-embeddings";
import { isNativeSearchScopeAvailable, setNativeSearchScope, setNativeSearchScopeIndex, clearNativeSearchScope, subscribeNativeSearchScope } from "@modules/search-scope";
import { stripMarkdown } from "@cairn/shared/notes/text";
import { useTheme, PRIORITY_COLOR, TAB_BAR_BASE, hasTabBarSearchField, type as typeScale, type Theme } from "@/theme";

type TypeFilter = "all" | "notes" | "tasks";

// Approx height of the native iOS 26 tab-bar search field — the results list
// clears it at the bottom so the last row isn't hidden behind it.
const SEARCH_FIELD_H = 52;
// The All|Notes|Tasks scope bar + its breathing gap below the search field.
const SCOPE_BAR_H = 40;
const SCOPE_GAP = 8;

/**
 * Search screen using the native iOS search bar (headerSearchBarOptions).
 * Two independent axes:
 *   - RANKING mode: semantic (meaning-based, on-device) vs keyword. Toggled by
 *     the ✨ header button; defaults ON when the device supports embeddings.
 *   - TYPE filter: All / Notes / Tasks (the scope bar below the search field),
 *     applied in both modes.
 */
export default function SearchScreen() {
  const router = useRouter();
  const t = useTheme();
  const semanticAvailable = isAppleEmbeddingsSupported();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  // Semantic ranking on by default when available; the header ✨ toggles it.
  const [semanticMode, setSemanticMode] = useState(semanticAvailable);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  // Vertical offset from the screen top to just below the native search field.
  // The results list underlaps the opaque header and `contentInsetAdjustmentBehavior`
  // "automatic" pushes its content down by exactly the header+search-field height —
  // we read that measured inset from scroll events and pin the scope bar there.
  // Until the first scroll, fall back to safe-area + search-field height.
  const [belowHeader, setBelowHeader] = useState(insets.top + SEARCH_FIELD_H);
  // The All|Notes|Tasks toggle lives in the native search field (UISearchController
  // scope bar) when this build has the search-scope module — UIKit owns its
  // animation and the header-height transitions. Elsewhere (Android, Expo Go,
  // older builds) we fall back to a JS SegmentedControl overlay.
  const usingNativeScope = isNativeSearchScopeAvailable();
  // Latest-value refs so the native scope subscription/apply never reads a stale
  // closure. Synced in effects (the react-hooks/refs rule forbids writing refs
  // during render); they're only READ in event handlers, so the one-render lag
  // is irrelevant.
  const typeFilterRef = useRef(typeFilter);
  useEffect(() => { typeFilterRef.current = typeFilter; }, [typeFilter]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [tasks, setTasks] = useState<CardRow[]>([]);
  const [hits, setHits] = useState<SemanticHit[]>([]);
  const [reindexing, setReindexing] = useState(false);
  const [stats, setStats] = useState<{ live: number; indexed: number } | null>(null);
  const [unindexed, setUnindexed] = useState<UnindexedNote[]>([]);
  const styles = useMemo(() => makeStyles(t), [t]);
  const searchRef = useRef<SearchBarCommands>(null);
  // Monotonic token so a slow semantic query can't overwrite a newer one.
  const semanticSeq = useRef(0);

  const run = useCallback((text: string, semantic: boolean, type: TypeFilter) => {
    const q = text.trim();
    if (q.length === 0) {
      semanticSeq.current++;
      setNotes([]);
      setTasks([]);
      setHits([]);
      return;
    }
    if (semantic) {
      // Embed the query and rank across all workspaces, over notes and/or cards
      // per the type filter, merged then ranked ONCE across the combined corpus
      // (finalizeRanking min-max-normalises over all workspaces, not per-DB).
      const seq = ++semanticSeq.current;
      (async () => {
        const all: SemanticHit[] = [];
        for (const ws of listWorkspaceIds()) {
          if (type !== "tasks") all.push(...(await semanticSearch(ws, q)));
          if (type !== "notes") all.push(...(await semanticSearchTasks(ws, q)));
        }
        finalizeRanking(all);
        if (seq === semanticSeq.current) setHits(all.slice(0, 30));
      })().catch((e) => console.warn("[search] semantic search failed:", e));
    } else {
      // Keyword mode: run the SQL LIKE queries for the selected type(s).
      setNotes(type !== "tasks" ? searchNotes(q) : []);
      setTasks(type !== "notes" ? searchTasks(q) : []);
    }
  }, []);

  // Debounce search-as-you-type so a burst of keystrokes fires one query after
  // input settles, not one per character.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runDebounced = useCallback(
    (text: string, semantic: boolean, type: TypeFilter) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => run(text, semantic, type), 200);
    },
    [run],
  );

  const onChange = (text: string) => {
    setQuery(text);
    runDebounced(text, semanticMode, typeFilter);
  };

  const setType = (type: TypeFilter) => {
    if (type !== typeFilter) haptics.selection();
    setTypeFilter(type);
    if (usingNativeScope) setNativeSearchScopeIndex(typeFilters.indexOf(type));
    if (debounceRef.current) clearTimeout(debounceRef.current);
    run(query, semanticMode, type);
  };

  const toggleSemantic = () => {
    if (!semanticAvailable) return;
    haptics.selection();
    const next = !semanticMode;
    setSemanticMode(next);
    if (next) {
      // Ensure the on-device index is built (downloads model assets on first use
      // + embeds not-yet-indexed items). IndexingBar shows progress; re-run when done.
      catchUpIndex()
        .then(() => run(query, true, typeFilter))
        .catch(() => {});
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    run(query, next, typeFilter);
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

  // Native scope bar: attach the All|Notes|Tasks titles to the search field on
  // focus and detach on blur. The header config may not have applied the search
  // controller yet on a fresh mount, so retry next frame if setScope finds
  // nothing. UIKit animates the scope bar in/out with focus. Wrapped in
  // useCallback so it only re-runs when focus actually changes (not every
  // render); mutable values are read through refs to avoid stale closures.
  const setTypeRef = useRef(setType);
  useEffect(() => { setTypeRef.current = setType; });
  useFocusEffect(
    useCallback(() => {
      if (!usingNativeScope) return;
      const sub = subscribeNativeSearchScope((idx) => {
        const f = typeFilters[idx];
        if (f && f !== typeFilterRef.current) setTypeRef.current(f);
      });
      const apply = () =>
        setNativeSearchScope(["All", "Notes", "Tasks"], typeFilters.indexOf(typeFilterRef.current));
      // Retry until the scope bar attaches: the search controller (and the
      // search bar's focus state, which gates scope visibility) can land a few
      // frames late on a cold mount / tab switch. ~1s of attempts is plenty.
      let tries = 0;
      const timer = setInterval(() => {
        void apply().then((ok) => {
          if (ok || ++tries >= 6) clearInterval(timer);
        });
      }, 150);
      void apply();
      return () => {
        clearInterval(timer);
        sub?.remove();
        void clearNativeSearchScope();
      };
    }, [usingNativeScope]),
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
    const missing: UnindexedNote[] = [];
    for (const ws of listWorkspaceIds()) {
      const s = embeddingIndexStats(ws);
      live += s.liveNotes + s.liveCards;
      indexed += s.indexedNotes + s.indexedCards;
      missing.push(...listUnindexedNotes(ws), ...listUnindexedCards(ws));
    }
    setStats({ live, indexed });
    setUnindexed(missing);
  }, []);

  // Pull-to-refresh on the Semantic list: force a full catch-up (embeds any
  // not-yet-indexed notes/cards — e.g. ones just synced from desktop), then
  // re-run the query + refresh the stats readout.
  const forceReindex = useCallback(async () => {
    setReindexing(true);
    try {
      await catchUpIndex();
      refreshStats();
      run(query, true, typeFilter);
    } catch (e) {
      console.warn("[search] reindex failed:", e);
      Alert.alert("Reindex failed", "Couldn't finish indexing for semantic search. Pull to try again.");
    } finally {
      setReindexing(false);
    }
  }, [query, typeFilter, run, refreshStats]);

  // Explain what isn't indexed and why (info affordance in the header).
  const showIndexInfo = useCallback(() => {
    const withContent = unindexed.filter((n) => n.contentLen > 0);
    const emptyCount = unindexed.length - withContent.length;
    const lines: string[] = [
      "Only items with body text an embedding can be built from are added to the semantic index.",
    ];
    if (emptyCount > 0) {
      lines.push(
        `\n${emptyCount} empty item${emptyCount === 1 ? "" : "s"} (no body text) — nothing to index. These aren't counted in the total.`,
      );
    }
    if (withContent.length > 0) {
      const names = withContent.slice(0, 8).map((n) => `• ${n.title || "Untitled"}`).join("\n");
      const more = withContent.length > 8 ? `\n…and ${withContent.length - 8} more` : "";
      lines.push(
        `\n${withContent.length} item${withContent.length === 1 ? "" : "s"} with content that hasn't been embedded yet. Reindex to try again — if one keeps failing, its body may have no indexable words (only symbols, links, or an image). Add some text and reindex to include it:\n\n${names}${more}`,
      );
    }
    if (unindexed.length === 0) {
      const gap = stats ? stats.live - stats.indexed : 0;
      if (gap > 0) {
        lines.push(
          `\n${gap} item${gap === 1 ? "" : "s"} counted as not indexed, but every note and task with content already has an index entry. This usually means stale index rows from a previous on-device model — tap Reindex to rebuild.`,
        );
      } else {
        lines.push("\nEverything with content is indexed.");
      }
    }
    const gap = stats ? stats.live - stats.indexed : 0;
    Alert.alert(
      "Semantic index",
      lines.join("\n"),
      withContent.length > 0 || gap > 0
        ? [
            { text: "Reindex now", onPress: () => void forceReindex() },
            { text: "OK", style: "cancel" as const },
          ]
        : [{ text: "OK", style: "cancel" as const }],
    );
  }, [unindexed, forceReindex, stats]);


  // Refresh stats whenever semantic mode is on or the tab regains focus.
  useFocusEffect(
    useCallback(() => {
      if (semanticMode) refreshStats();
    }, [semanticMode, refreshStats]),
  );

  const hasQuery = query.trim().length > 0;

  // Keyword mode merges notes + tasks into one list (tagged with kind) so the
  // Type filter's "All" can show both. Semantic mode uses `hits` directly.
  interface KeywordRow { id: string; title: string; preview: string; kind: "note" | "card"; priority?: string }
  const keywordResults: KeywordRow[] = useMemo(() => {
    if (semanticMode) return [];
    const rows: KeywordRow[] = [];
    if (typeFilter !== "tasks") {
      for (const n of notes) rows.push({ id: n.id, title: n.title, preview: stripMarkdown(n.content ?? "").slice(0, 100), kind: "note" });
    }
    if (typeFilter !== "notes") {
      for (const c of tasks) rows.push({ id: c.id, title: c.title, preview: stripMarkdown(c.description ?? "").slice(0, 100), kind: "card", priority: c.priority });
    }
    return rows;
  }, [semanticMode, typeFilter, notes, tasks]);

  const isListEmpty = (semanticMode ? hits.length : keywordResults.length) === 0;

  const typeFilters: TypeFilter[] = ["all", "notes", "tasks"];
  const typeLabel = (f: TypeFilter) => (f === "all" ? "All" : f === "notes" ? "Notes" : "Tasks");
  const placeholder = semanticMode ? "Search by meaning…" : "Search notes and tasks";

  // Primary + secondary hint lines for the empty state (ListEmptyComponent).
  const emptyHint: { primary: string; secondary?: string } = (() => {
    if (semanticMode) {
      if (!semanticAvailable) return { primary: appleEmbeddingsUnavailableReason() };
      if (hasQuery) return { primary: "No semantically similar results" };
      return {
        primary: "Search your notes and tasks by meaning, not just keywords.",
        secondary: stats
          ? `${stats.indexed} of ${stats.live} items indexed${stats.indexed < stats.live ? " · pull down to finish indexing" : ""}`
          : undefined,
      };
    }
    const what = typeFilter === "notes" ? "notes" : typeFilter === "tasks" ? "tasks" : "notes and tasks";
    return { primary: hasQuery ? `No matching ${what}` : `Search ${what} by keyword.` };
  })();

  // Space to clear below the search field for the scope control. When the scope
  // lives natively in the search field, UIKit's automatic content inset already
  // includes it; the JS fallback overlay needs explicit room.
  const scopeClearance = usingNativeScope ? 0 : SCOPE_BAR_H + SCOPE_GAP;

  // Shared list scrolling behaviour. `contentInsetAdjustmentBehavior="automatic"`
  // makes the list clear the native search header (top) — including the scope
  // bar when it's native. The top pad in `contentContainerStyle` clears the JS
  // fallback scope overlay (zero when native), and the bottom pad clears the
  // tab-bar/search-field/keyboard area, so we do NOT set
  // `automaticallyAdjustKeyboardInsets` — combined with the automatic top inset
  // it miscalculates the content offset when the keyboard opens and scrolls the
  // first result up under the header. IndexingBar rides as the list header so
  // the FlatList stays the screen's first (and only) scroll view — required for
  // iOS to apply the automatic search-header inset.
  //
  // The empty/hint state is NO LONGER a ListEmptyComponent — it's a pinned
  // absolute-overlay SIBLING of the list (see below). Rendering it inside the
  // list coupled it to the list's keyboard-driven content inset, so it jumped
  // around when the keyboard opened. As a screen-pinned sibling it stays put,
  // and uses the same anchoring system as Chat's empty state.
  const listProps = {
    // Empty state: use flexGrow-only (no results padding) so the content is
    // exactly the viewport height and the screen doesn't scroll. With results:
    // apply the list padding that clears the scope bar / tab bar / keyboard.
    contentContainerStyle: isListEmpty
      ? styles.listGrow
      : [styles.list, { paddingTop: 12 + scopeClearance }],
    // Nothing to scroll when empty — also stops the list being draggable under
    // the header. EXCEPT semantic mode, which needs to stay scrollable when
    // empty so its pull-to-reindex RefreshControl works.
    scrollEnabled: !isListEmpty || semanticMode,
    contentInsetAdjustmentBehavior: "automatic" as const,
    keyboardShouldPersistTaps: "handled" as const,
    keyboardDismissMode: "on-drag" as const,
    ListHeaderComponent: <IndexingBar />,
    // Read the effective top content inset iOS applies to clear the native
    // search field, and pin the fallback scope overlay to that exact offset.
    scrollEventThrottle: 16,
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const top = e.nativeEvent.contentInset?.top ?? 0;
      if (top > 0 && top !== belowHeader) setBelowHeader(top);
    },
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
          // Header trailing controls: an optional info button (shown when
          // semantic mode is on and some items aren't indexed — always visible
          // here, unlike an empty-state child that can hide behind the list/tab
          // bar) plus the ✨ semantic ranking toggle. The toggle is hidden
          // entirely when the device can't do on-device embeddings. iOS 26+
          // wraps each in its own glass toolbar button.
          headerRight: semanticAvailable
            ? () => (
                <View style={styles.headerRight}>
                  {semanticMode && stats && stats.indexed < stats.live ? (
                    <Pressable
                      onPress={showIndexInfo}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel="Why aren't all items indexed?"
                      style={styles.semBtn}
                    >
                      <Info size={18} color={t.warning} />
                    </Pressable>
                  ) : null}
                  <Pressable
                    onPress={toggleSemantic}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Semantic search"
                    accessibilityState={{ selected: semanticMode }}
                    style={styles.semBtn}
                  >
                    <Sparkles size={18} color={semanticMode ? t.accent : t.textTertiary} />
                  </Pressable>
                </View>
              )
            : undefined,
        }}
      />

      {/* Type filter. With the native scope module this lives IN the search
          field itself (UISearchController scope bar — UIKit animates it with
          focus). Fallback (Android / builds without the module): a JS
          SegmentedControl pinned at `belowHeader`, the measured height the
          list's automatic content inset uses to clear the search field. */}
      {!usingNativeScope ? (
        <View style={[styles.topScope, { top: belowHeader }]}>
          <SegmentedControl
            values={typeFilters.map(typeLabel)}
            selectedIndex={typeFilters.indexOf(typeFilter)}
            onChange={(e) => setType(typeFilters[e.nativeEvent.selectedSegmentIndex] ?? "all")}
            tintColor={t.accent}
            backgroundColor={t.surface2}
            fontStyle={{ color: t.textSecondary, fontSize: 15, fontWeight: "600" }}
            activeFontStyle={{ color: t.accentFg, fontSize: 15, fontWeight: "600" }}
          />
        </View>
      ) : null}

      <View style={styles.results}>
        {semanticMode ? (
          <FlatList
            data={hits}
            keyExtractor={(h) => `${h.kind ?? "note"}:${h.noteId}`}
            {...listProps}
            refreshControl={
              <RefreshControl refreshing={reindexing} onRefresh={forceReindex} tintColor={t.textTertiary} />
            }
            renderItem={({ item }) => (
              <ResultRow
                title={item.title}
                preview={item.kind === "card" ? `Task · ${item.sectionTitle}` : item.sectionTitle}
                score={item.rank}
                accentColor={item.kind === "card" ? t.success : t.info}
                onPress={() =>
                  openResult(
                    item.kind === "card"
                      ? { pathname: "/card/[id]", params: { id: item.noteId, back: "Search" } }
                      : { pathname: "/note/[id]", params: { id: item.noteId, back: "Search" } },
                  )
                }
              />
            )}
          />
        ) : (
          <FlatList
            data={keywordResults}
            keyExtractor={(r) => `${r.kind}:${r.id}`}
            {...listProps}
            renderItem={({ item }) => (
              <ResultRow
                title={item.title}
                preview={item.kind === "card" ? `Task · ${item.preview}` : item.preview}
                accentColor={item.kind === "card" ? t.success : t.info}
                dotColor={item.kind === "card" ? PRIORITY_COLOR[item.priority as keyof typeof PRIORITY_COLOR] ?? undefined : undefined}
                onPress={() =>
                  openResult(
                    item.kind === "card"
                      ? { pathname: "/card/[id]", params: { id: item.id, back: "Search" } }
                      : { pathname: "/note/[id]", params: { id: item.id, back: "Search" } },
                  )
                }
              />
            )}
          />
        )}

        {/* Empty state as a screen-pinned overlay SIBLING of the list (not a
            ListEmptyComponent). Decoupled from the list's keyboard/content inset,
            so it never jumps when the keyboard opens — and it shares Chat's exact
            anchoring system (pinned + default 25% top bias). `insetTop` clears
            the native search header; `pointerEvents="none"`
            (inside EmptyState) lets scroll / pull-to-reindex gestures pass
            through to the list beneath. Only shown when the list is empty. */}
        {isListEmpty ? (
          hasQuery ? (
            // Active search with no matches → light top-anchored text hint (no
            // branded splash — that's the resting state, not a "found nothing"
            // state). Pinned so it holds position when the keyboard is open.
            <View
              pointerEvents="none"
              style={[styles.hintOverlay, { paddingTop: belowHeader + scopeClearance }]}
            >
              <View style={styles.hintBias} />
              <Text style={styles.hint}>{emptyHint.primary}</Text>
              {emptyHint.secondary ? <Text style={styles.statHint}>{emptyHint.secondary}</Text> : null}
            </View>
          ) : (
            // Resting (no query) → branded Cairn empty state. The "why not all
            // indexed?" affordance lives in the header (see headerRight) so it's
            // always visible and never hides behind the list or tab bar.
            <EmptyState
              title={emptyHint.primary}
              subtitle={emptyHint.secondary}
              pinned
              insetTop={belowHeader + scopeClearance}
            />
          )
        ) : null}
      </View>
    </TabScreen>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    // Results list region (underlaps the opaque header; automatic content inset
    // clears the search field + the native scope bar when present).
    results: { flex: 1 },
    // JS fallback All|Notes|Tasks scope bar (native UISegmentedControl) —
    // absolute, top is set inline to `belowHeader`, shown only when the native
    // scope module isn't available. zIndex keeps it above the results list
    // (which is later in the tree).
    topScope: { position: "absolute", left: 12, right: 12, zIndex: 1 },
    // Header ✨ semantic toggle: bare icon, no background — iOS supplies its own
    // toggle chrome. Colour (accent vs tertiary) is the on/off signal.
    semBtn: { alignItems: "center", justifyContent: "center", paddingHorizontal: 4 },
    // Bottom pad clears the tab bar + the native search field on iOS ≤26 (none
    // on iOS 27, so drop that reservation) with a small buffer. The top pad is
    // applied inline (`paddingTop: 12 + scopeClearance`) so it's zero extra when
    // the scope bar is native.
    list: {
      padding: 12,
      paddingBottom: 12 + TAB_BAR_BASE + (hasTabBarSearchField ? SEARCH_FIELD_H : 0) + 12,
    },
    // Lets an empty list stay exactly the viewport height (no scroll) — the
    // pinned empty-state overlay sits on top of it as a sibling.
    listGrow: { flexGrow: 1 },
    // Active-search "no matches" hint — a screen-pinned overlay sibling of the
    // list (matches the branded EmptyState's positioning) so it doesn't jump
    // when the keyboard opens. Icon-less; just the top-biased text. paddingTop
    // clears the search header + the pinned scope bar.
    hintOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", paddingHorizontal: 32 },
    // Push the hint text down to the same ~25% position as the branded state.
    hintBias: { height: "25%" },
    hint: { textAlign: "center", color: t.textTertiary },
    statHint: { ...typeScale.caption, textAlign: "center", color: t.textTertiary, marginTop: 8 },
    headerRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  });
}
