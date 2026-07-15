import { useCallback, useMemo, useState } from "react";
import { View, FlatList, StyleSheet, ActionSheetIOS, Alert, Platform, type ListRenderItem } from "react-native";
import { useLocalSearchParams, useRouter, Stack, type Href } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  getProject,
  getProjectOverview,
  listNotes,
  listColumns,
  listCards,
  listProjects,
  listFolders,
  moveCardToColumn,
  moveNoteToProject,
  moveNotesToFolder,
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
import { NotePickerSheet, type PickerOption } from "@/components/NotePickerSheet";
import { ICON_ADD, ICON_CALENDAR } from "@/components/toolbar-icons";
import { haptics, toolbarPress } from "@/haptics";
import { DraggableBoard } from "@/components/DraggableBoard";
import { OverviewTab } from "@/components/overview/OverviewTab";
import { EmptyState } from "@/components/EmptyState";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { useTheme, TAB_BAR_BASE, type Theme } from "@/theme";
import { buildFolderTree, type FolderNode } from "@cairn/shared/notes/folder-tree";
import { NoteRowItem } from "./project/NoteRowItem";
import { FolderRow } from "./project/FolderRow";
import { Segment } from "./project/Segment";
import { Empty } from "./project/Empty";
import { NoteFilterBar } from "./project/NoteFilterBar";
import { type ListRow, rowKey } from "./project/list-rows";

type Tab = "overview" | "notes" | "board";

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
  // The note currently targeted by the long-press action menu, and which
  // move-picker sheet (if any) is open for it. `null` = no menu/sheet.
  const [actionNote, setActionNote] = useState<NoteRow | null>(null);
  const [picker, setPicker] = useState<null | "project" | "folder">(null);
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
  // actions open a themed BottomSheet picker (NotePickerSheet). Kept as stable
  // callbacks so the memoised NoteRowItem rows don't re-render.

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
      else if (choice === "project") { setActionNote(note); setPicker("project"); }
      else if (choice === "folder") { setActionNote(note); setPicker("folder"); }
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

  // Commit a picker selection, then close the menu + sheet and refresh the list.
  const onPickProject = useCallback((projectId: string) => {
    if (actionNote) {
      const res = moveNoteToProject(actionNote.id, projectId);
      if ("error" in res) {
        // Surface the failure and keep the picker open (state intact) so the
        // user can retry or pick a different target — don't silently swallow it.
        haptics.error();
        Alert.alert("Couldn't move note", res.error);
        return;
      }
      haptics.success();
    }
    setPicker(null);
    setActionNote(null);
    load();
  }, [actionNote, load]);

  const onPickFolder = useCallback((folder: string) => {
    if (actionNote) {
      moveNotesToFolder([actionNote.id], folder);
      haptics.success();
    }
    setPicker(null);
    setActionNote(null);
    load();
  }, [actionNote, load]);

  const closePicker = useCallback(() => { setPicker(null); setActionNote(null); }, []);

  // Picker option lists, computed only while the relevant sheet is open. The
  // project list excludes the current project; the folder list is prefixed with
  // an explicit "Root" (folder="") option, matching the desktop folder picker.
  const projectOptions = useMemo<PickerOption[]>(
    () =>
      picker === "project"
        ? listProjects()
            .filter((p) => p.id !== id)
            .map((p) => ({ value: p.id, label: p.name, icon: p.icon }))
        : [],
    [picker, id],
  );
  const folderOptions = useMemo<PickerOption[]>(() => {
    if (picker !== "folder" || !id) return [];
    const opts: PickerOption[] = [{ value: "", label: "Root" }];
    for (const f of listFolders(id)) {
      if (f) opts.push({ value: f, label: f });
    }
    return opts;
  }, [picker, id]);

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
    if (tab === "board") router.push({ pathname: "/card/new", params: { project: id } });
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
        <Segment label="Overview" active={tab === "overview"} onPress={() => setTab("overview")} t={t} />
        <Segment label="Notes" count={notes.length} active={tab === "notes"} onPress={() => setTab("notes")} t={t} />
        <Segment label="Board" count={cards.length} active={tab === "board"} onPress={() => setTab("board")} t={t} />
      </View>

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
          bottomInset={insets.bottom + (nested ? TAB_BAR_BASE : 0)}
          onMove={(cardId, colId) => {
            moveCardToColumn(cardId, colId);
            load();
          }}
          onOpenCard={(cid) => router.push(cardHref(cid))}
          onAddCard={(colId) => router.push({ pathname: "/card/new", params: { project: id, column: colId } })}
        />
      )}

      {/* Long-press move pickers. Options are read lazily (only while the sheet
          is open) so they reflect the current DB without polling. */}
      <NotePickerSheet
        visible={picker === "project"}
        title="Move to project"
        variant="project"
        options={projectOptions}
        selectedValue={id}
        emptyText="No other projects in this workspace."
        onSelect={onPickProject}
        onClose={closePicker}
      />
      <NotePickerSheet
        visible={picker === "folder"}
        title="Move to folder"
        variant="folder"
        options={folderOptions}
        selectedValue={actionNote?.folder ?? ""}
        emptyText="No folders in this project yet."
        onSelect={onPickFolder}
        onClose={closePicker}
      />
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.background },
    segment: { flexDirection: "row", gap: 4, margin: 12, padding: 4, backgroundColor: t.surface2, borderRadius: 10 },
    notesScroll: { flexGrow: 1 },
  });
}
