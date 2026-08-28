/* eslint-disable react-hooks/exhaustive-deps -- stable callbacks, intentional */
import { useCallback, useMemo, useState } from "react";
import { View, FlatList, StyleSheet, ActionSheetIOS, Alert, Platform, type ListRenderItem } from "react-native";
import { useLocalSearchParams, useRouter, Stack, type Href } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import SegmentedControl from "@react-native-segmented-control/segmented-control";
import {
  getProject,
  getProjectOverview,
  listNotes,
  listColumns,
  listCards,
  moveCardToColumn,
  moveNoteToProject,
  moveNotesToFolder,
  archiveCard,
  deleteCard,
  pinNote,
  softDeleteNote,
  tagsByRow,
  tagsForNotes,
  noteTagIds,
  type NoteRow,
  type CardRow,
  type ColumnRow,
  type ProjectOverviewData,
} from "@/db/queries";
import { newSheetResultKey, registerSheetResult } from "@/lib/sheet-result";
import { ICON_ADD, ICON_CALENDAR } from "@/components/toolbar-icons";
import { haptics, toolbarPress } from "@/haptics";
import { DraggableBoard } from "@/components/DraggableBoard";
import { toast } from "@/components/Toast";
import { OverviewTab } from "@/components/overview/OverviewTab";
import { EmptyState } from "@/components/EmptyState";
import { celebrateTaskDone, isDoneColumn } from "@/gamification/rewards";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { useTheme, type Theme } from "@/theme";
import { buildFolderTree, type FolderNode } from "@cairn/shared/notes/folder-tree";
import { NoteRowItem } from "./project/NoteRowItem";
import { FolderRow } from "./project/FolderRow";
import { Empty } from "./project/Empty";
import { NoteFilterBar } from "./project/NoteFilterBar";
import { type ListRow, rowKey } from "./project/list-rows";

type Tab = "overview" | "notes" | "board";

// Order of the native UISegmentedControl segments (Overview | Notes | Board);
// the control's selectedIndex maps straight into the `tab` union.
const PROJECT_TABS: Tab[] = ["overview", "notes", "board"];

// Height of the floating Overview|Notes|Board bar (control 36 + 8 top + 6
// bottom padding) — tab content clears this so the first row isn't hidden.
const SEGMENT_BAR_H = 50;

/**
 * Project detail (notes tree + board). Shared by two routes:
 *
 *   • `app/project/[id].tsx` (root stack) — reached from Graph, so the detail
 *     pushes over the tab bar as before.
 *   • `app/(tabs)/projects/project/[id].tsx` (Projects tab stack, `nested`) — the
 *     Projects-tab drill-down, which keeps the native tab bar visible and pops
 *     back to the project list when the Projects tab is re-tapped.
 *
 * `nested` only changes the onward navigation targets: nested pushes stay inside
 * the Projects tab (`/projects/...`) so the whole flow keeps the tab bar; the root
 * copy pushes plain `/...` routes. Typed routes require the two path families to
 * be spelled out explicitly, hence the `Href` helpers below.
 */
export function ProjectScreen({ nested = false }: { nested?: boolean }) {
  const { id, back } = useLocalSearchParams<{ id: string; back?: string }>();
  const router = useRouter();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  // Bottom padding so the list can scroll its last rows clear of the bottom
  // safe area. `insets.bottom` already includes the native tab bar on a tab
  // screen (see TAB_BAR_BASE doc), so we no longer add it separately; the +24
  // is scroll slack above the bar / home indicator.
  const listBottomPad = 24 + insets.bottom;
  const [tab, setTab] = useState<Tab>("overview");
  const [project, setProject] = useState(id ? getProject(id) : null);
  const [overview, setOverview] = useState<ProjectOverviewData | null>(null);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [columns, setColumns] = useState<ColumnRow[]>([]);
  const [cards, setCards] = useState<CardRow[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState("");
  const [activeTagId, setActiveTagId] = useState<string | null>(null);
  // Brief spinner state for the Overview pull-to-refresh gesture.
  const [refreshing, setRefreshing] = useState(false);

  // Onward-navigation targets. Kept as typed Href builders so the nested vs.
  // root path families both satisfy typed routes.
  const noteHref = useCallback(
    (nid: string): Href =>
      nested ? { pathname: "/projects/note/[id]", params: { id: nid } } : { pathname: "/note/[id]", params: { id: nid } },
    [nested],
  );
  const cardHref = useCallback(
    (cid: string): Href =>
      nested ? { pathname: "/projects/card/[id]", params: { id: cid } } : { pathname: "/card/[id]", params: { id: cid } },
    [nested],
  );

  const load = useCallback(() => {
    if (!id) return;
    setProject(getProject(id));
    setOverview(getProjectOverview(id));
    setNotes(listNotes(id));
    setColumns(listColumns(id));
    setCards(listCards(id));
  }, [id]);

  useRefreshOnFocus(load);

  // Pull-to-refresh on the Overview tab. load() is synchronous (local SQLite),
  // so hold the spinner briefly for tactile feedback rather than flashing it off
  // instantly. A short delay also lets any in-flight background sync settle.
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    haptics.selection();
    load();
    setTimeout(() => setRefreshing(false), 500);
  }, [load]);

  // A single stable note-open handler built from the (stable) href builder, so
  // the memoised rows below keep the SAME onOpen reference across renders and
  // actually skip re-rendering when unrelated state (filter text, collapse)
  // changes. Passing a fresh `() => push(...)` per row would defeat React.memo.
  const openNote = useCallback((nid: string) => router.push(noteHref(nid)), [router, noteHref]);

  // ── Long-press note actions ────────────────────────────────────────────────
  // A per-note contextual menu mirroring the desktop note ⋯ menu (Pin/Unpin,
  // Move to project, Move to folder, Delete). Presented as a native action
  // sheet (iOS) / Alert action list (Android) on long-press; the two "Move"
  // actions open the native formSheet picker route (app/picker/note.tsx). Kept
  // as stable callbacks so the memoised NoteRowItem rows don't re-render.

  const togglePin = useCallback((note: NoteRow) => {
    pinNote(note.id, !note.is_pinned);
    haptics.success();
    load();
  }, [load]);

  const confirmDelete = useCallback((note: NoteRow) => {
    haptics.warning();
    Alert.alert(
      "Delete note?",
      `"${note.title || "Untitled"}" will be deleted. This syncs to your other devices.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            softDeleteNote(note.id);
            load();
          },
        },
      ],
    );
  }, [load]);

  const showNoteActions = useCallback((note: NoteRow) => {
    haptics.selection();
    const pinLabel = note.is_pinned ? "Unpin" : "Pin";
    const run = (choice: "pin" | "project" | "folder" | "delete") => {
      if (choice === "pin") togglePin(note);
      else if (choice === "project") openMovePicker(note, "project");
      else if (choice === "folder") openMovePicker(note, "folder");
      else if (choice === "delete") confirmDelete(note);
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: note.title || "Untitled",
          options: [pinLabel, "Move to project", "Move to folder", "Delete", "Cancel"],
          destructiveButtonIndex: 3,
          cancelButtonIndex: 4,
        },
        (i) => {
          if (i === 0) run("pin");
          else if (i === 1) run("project");
          else if (i === 2) run("folder");
          else if (i === 3) run("delete");
        },
      );
    } else {
      Alert.alert(note.title || "Untitled", undefined, [
        { text: pinLabel, onPress: () => run("pin") },
        { text: "Move to project", onPress: () => run("project") },
        { text: "Move to folder", onPress: () => run("folder") },
        { text: "Delete", style: "destructive", onPress: () => run("delete") },
        { text: "Cancel", style: "cancel" },
      ]);
    }
  }, [togglePin, confirmDelete]);

  // Open the native move picker (project / folder) for `note`. The picked value
  // comes back through the sheet-result bus; failure surfaces as an alert after
  // the sheet closes.
  const openMovePicker = useCallback(
    (note: NoteRow, variant: "project" | "folder") => {
      const key = newSheetResultKey();
      registerSheetResult<string>(key, (value) => {
        if (variant === "project") {
          const res = moveNoteToProject(note.id, value);
          if ("error" in res) {
            haptics.error();
            Alert.alert("Couldn't move note", res.error);
            return;
          }
        } else {
          moveNotesToFolder([note.id], value);
        }
        haptics.success();
        load();
      });
      router.push({
        pathname: "/picker/note",
        params: {
          resultKey: key,
          title: variant === "project" ? "Move to project" : "Move to folder",
          variant,
          excludeProjectId: variant === "project" ? (id ?? undefined) : undefined,
          projectId: variant === "folder" ? (id ?? undefined) : undefined,
          currentValue: variant === "folder" ? (note.folder ?? "") : undefined,
          emptyText:
            variant === "project"
              ? "No other projects in this workspace."
              : "No folders in this project yet.",
        },
      });
    },
    [id, load, router],
  );

  const tree = useMemo(() => buildFolderTree(notes), [notes]);
  const styles = useMemo(() => makeStyles(t), [t]);
  const toggle = useCallback((path: string) => setCollapsed((c) => ({ ...c, [path]: !c[path] })), []);

  // Resolve every note's tags in ONE query up front (memoised on the notes),
  // then look each note up by id when rendering its row — instead of firing a
  // per-row `tagsForNote()` query during render.
  const tagMap = useMemo(() => tagsByRow(notes), [notes]);

  // Distinct tags used by this project's notes — the filter chip row.
  const projectTags = useMemo(() => tagsForNotes(notes), [notes]);

  // Text + tag filter, mirroring the desktop useNoteFilter (title/content
  // contains + active-tag membership). While filtering we show a flat list
  // instead of the folder tree.
  const isFiltering = !!(filter || activeTagId);
  const filtered = useMemo(() => {
    if (!isFiltering) return [];
    const q = filter.toLowerCase();
    return notes.filter((n) => {
      const matchesText =
        !filter ||
        (n.title ?? "").toLowerCase().includes(q) ||
        (n.content ?? "").toLowerCase().includes(q);
      const matchesTag = !activeTagId || noteTagIds(n).includes(activeTagId);
      return matchesText && matchesTag;
    });
  }, [notes, filter, activeTagId, isFiltering]);

  // Flatten what's on screen into ONE linear row array so a single FlatList can
  // virtualize it — mounting only visible rows instead of every note/folder at
  // once (projects can have hundreds of notes). Filtering shows a flat note
  // list; otherwise the folder tree, walked depth-first and skipping the
  // subtrees of collapsed folders.
  const rows = useMemo<ListRow[]>(() => {
    if (isFiltering) return filtered.map((n) => ({ kind: "note", note: n, depth: 0 }));
    const out: ListRow[] = [];
    const walk = (node: FolderNode<NoteRow>, depth: number) => {
      out.push({ kind: "folder", node, depth });
      if (collapsed[node.path]) return;
      for (const child of node.children) walk(child, depth + 1);
      for (const n of node.notes) out.push({ kind: "note", note: n, depth: depth + 1 });
    };
    for (const f of tree.folders) walk(f, 0);
    for (const n of tree.rootNotes) out.push({ kind: "note", note: n, depth: 0 });
    return out;
  }, [isFiltering, filtered, tree, collapsed]);

  const renderRow = useCallback<ListRenderItem<ListRow>>(
    ({ item }) =>
      item.kind === "folder" ? (
        <FolderRow node={item.node} depth={item.depth} collapsed={!!collapsed[item.node.path]} onToggle={toggle} t={t} />
      ) : (
        <NoteRowItem note={item.note} depth={item.depth} tags={tagMap.get(item.note.id)} onOpen={openNote} onLongPress={showNoteActions} t={t} />
      ),
    [collapsed, toggle, t, tagMap, openNote, showNoteActions],
  );

  const onAdd = () => {
    if (!id) return;
    // New-note / new-task are modals in the root stack (they present over the
    // tab bar by design), so they stay absolute for both variants. On the
    // Overview segment the + is hidden, so default the action to a new note.
    if (tab === "board") router.push({ pathname: "/card/new", params: { project: id, back: project?.name || "Project" } });
    else router.push({ pathname: "/note/new", params: { project: id } });
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: project?.name || "Project",
          // From Graph (root stack) the back target is the `(tabs)` group, so an
          // explicit `back` label is passed; the nested Projects-list flow omits
          // it and gets iOS's default "Projects" previous-title.
          ...(back ? { headerBackTitle: back } : {}),
        }}
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={ICON_CALENDAR}
          accessibilityLabel="Calendar"
          onPress={toolbarPress(() =>
            id &&
            router.push(
              nested
                ? { pathname: "/projects/project/calendar", params: { project: id } }
                : { pathname: "/project/calendar", params: { project: id } },
            )
          )}
        />
        <Stack.Toolbar.Button
          icon={ICON_ADD}
          accessibilityLabel={tab === "board" ? "New task" : "New note"}
          onPress={toolbarPress(onAdd)}
          hidden={tab === "overview"}
        />
      </Stack.Toolbar>

      <View style={styles.segment}>
        <SegmentedControl
          // No flex:1 — Yoga's flexBasis:0 makes the native view collapse to
          // height 0 when the parent's height is content-driven. Width stretches
          // via the default alignItems:stretch; only the height needs setting.
          // No backgroundColor: UISegmentedControl's track is a private subview
          // on iOS 13+, so the prop can't strip it — we let the native iOS
          // 26/27 Liquid Glass track render and tint only the selected segment.
          style={{ height: 36 }}
          tintColor={t.accent}
          fontStyle={{ color: t.textSecondary, fontSize: 15, fontWeight: "600" }}
          activeFontStyle={{ color: t.accentFg, fontSize: 15, fontWeight: "600" }}
          values={["Overview", `Notes ${notes.length}`, `Board ${cards.length}`]}
          selectedIndex={PROJECT_TABS.indexOf(tab)}
          onChange={(e) => setTab(PROJECT_TABS[e.nativeEvent.selectedSegmentIndex] ?? "overview")}
        />
      </View>

      <View style={styles.content}>
        {tab === "overview" ? (
        overview ? (
          <OverviewTab
            data={overview}
            bottomPad={listBottomPad}
            onRefresh={onRefresh}
            refreshing={refreshing}
            nav={{
              onOpenNote: (nid) => router.push(noteHref(nid)),
              onOpenCard: (cid) => router.push(cardHref(cid)),
              onViewNotes: () => setTab("notes"),
              onViewBoard: () => setTab("board"),
            }}
          />
        ) : (
          <View style={{ flex: 1 }} />
        )
      ) : tab === "notes" ? (
        notes.length === 0 ? (
          <EmptyState title="No notes yet" subtitle="Tap + to create your first note." align="top" />
        ) : (
          <View style={{ flex: 1 }}>
            <NoteFilterBar
              filter={filter}
              onFilter={setFilter}
              tags={projectTags}
              activeTagId={activeTagId}
              onToggleTag={(tid) => setActiveTagId((cur) => (cur === tid ? null : tid))}
            />
            {isFiltering && filtered.length === 0 ? (
              <Empty text="No notes match your filter." t={t} />
            ) : (
              <FlatList
                data={rows}
                keyExtractor={rowKey}
                renderItem={renderRow}
                contentContainerStyle={[styles.notesScroll, { paddingBottom: listBottomPad }]}
                keyboardShouldPersistTaps="handled"
                // Windowing tuned for a text-row list: keep a modest buffer so
                // fast scrolls stay filled without over-mounting.
                initialNumToRender={20}
                maxToRenderPerBatch={20}
                windowSize={11}
                removeClippedSubviews
              />
            )}
          </View>
        )
      ) : (
        <DraggableBoard
          columns={columns}
          cards={cards}
          bottomInset={insets.bottom}
          onMove={(cardId, colId) => {
            // Detect a genuine "into done" transition before mutating: the card
            // must be moving INTO a done column from a non-done one — not a
            // reorder within done. Celebrate with haptic + toast (+ future
            // confetti) and message how many open tasks remain.
            const targetCol = columns.find((c) => c.id === colId);
            const card = cards.find((c) => c.id === cardId);
            const fromCol = card ? columns.find((c) => c.id === card.column_id) : undefined;
            const completing = isDoneColumn(targetCol) && !isDoneColumn(fromCol);

            moveCardToColumn(cardId, colId);
            load();

            if (completing) {
              const doneColIds = new Set(columns.filter((c) => isDoneColumn(c)).map((c) => c.id));
              // After this move, count cards still outside any done column.
              const remainingOpen = cards.filter(
                (c) => c.id !== cardId && !doneColIds.has(c.column_id),
              ).length;
              celebrateTaskDone(remainingOpen);
            }
          }}
          onOpenCard={(cid) => router.push(cardHref(cid))}
          onAddCard={(colId) => router.push({ pathname: "/card/new", params: { project: id, column: colId, back: project?.name || "Project" } })}
          onArchive={(card) => {
            archiveCard(card.id);
            load();
            haptics.success();
            toast.success("Task archived", { detail: card.title });
          }}
          onDelete={(card) => {
            // Destructive — confirm first. Deleting soft-deletes (tombstone) and
            // syncs the removal to peers, matching the desktop delete zone.
            Alert.alert(
              "Delete task?",
              `"${card.title}" will be deleted. This can't be undone.`,
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Delete",
                  style: "destructive",
                  onPress: () => {
                    deleteCard(card.id);
                    load();
                    haptics.impactHeavy();
                    toast.success("Task deleted");
                  },
                },
              ],
            );
          }}
        />
      )}
      </View>

      {/* Long-press move pickers now live in the native formSheet routes
          (app/picker/note.tsx), opened via openMovePicker. */}
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.background },
    // Floating Overview|Notes|Board bar in the header colour: an absolute
    // overlay pinned below the nav bar, so the tab content scrolls beneath it
    // (like the search scope bar). Height = control 36 + 8 top + 6 bottom pad.
    segment: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      zIndex: 1,
      backgroundColor: t.surface,
      paddingHorizontal: 12,
      paddingTop: 8,
      paddingBottom: 6,
    },
    // Tab content clears the floating segment bar (SEGMENT_BAR_H) plus a small
    // breathing gap so the first row isn't flush against the control.
    content: { flex: 1, paddingTop: SEGMENT_BAR_H + 8 },
    notesScroll: { flexGrow: 1 },
  });
}
