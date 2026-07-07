import { useCallback, useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter, useFocusEffect, Stack, type Href } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronDown, ChevronRight, Folder, FolderOpen, FileText, Pin } from "lucide-react-native";
import {
  getProject,
  listNotes,
  listColumns,
  listCards,
  moveCardToColumn,
  tagsForNote,
  tagsForNotes,
  noteTagIds,
  type NoteRow,
  type CardRow,
  type ColumnRow,
  type TagRow,
} from "@/db/queries";
import { TagChips } from "@/components/TagChips";
import { PressableScale } from "@/components/PressableScale";
import { SearchField } from "@/components/SearchField";
import { ICON_ADD, ICON_CALENDAR } from "@/components/toolbar-icons";
import { DraggableBoard } from "@/components/DraggableBoard";
import { useDataChanged } from "@/sync/useSyncStatus";
import { useTheme, withAlpha, type as typeScale, type Theme } from "@/theme";
import { buildFolderTree, type FolderNode } from "@cairn/shared/notes/folder-tree";
import { stripMarkdown } from "@cairn/shared/notes/text";
import { formatRelative } from "@cairn/shared/format/date";

type Tab = "notes" | "board";

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
  const [tab, setTab] = useState<Tab>("notes");
  const [project, setProject] = useState(id ? getProject(id) : null);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [columns, setColumns] = useState<ColumnRow[]>([]);
  const [cards, setCards] = useState<CardRow[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState("");
  const [activeTagId, setActiveTagId] = useState<string | null>(null);

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
    setNotes(listNotes(id));
    setColumns(listColumns(id));
    setCards(listCards(id));
  }, [id]);

  useFocusEffect(useCallback(() => load(), [load]));
  useDataChanged(load);

  const tree = useMemo(() => buildFolderTree(notes), [notes]);
  const styles = useMemo(() => makeStyles(t), [t]);
  const toggle = (path: string) => setCollapsed((c) => ({ ...c, [path]: !c[path] }));

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

  const onAdd = () => {
    if (!id) return;
    // New-note / new-task are modals in the root stack (they present over the
    // tab bar by design), so they stay absolute for both variants.
    if (tab === "notes") router.push({ pathname: "/note/new", params: { project: id } });
    else router.push({ pathname: "/card/new", params: { project: id } });
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
          onPress={() =>
            id &&
            router.push(
              nested
                ? { pathname: "/projects/project/calendar", params: { project: id } }
                : { pathname: "/project/calendar", params: { project: id } },
            )
          }
        />
        <Stack.Toolbar.Button
          icon={ICON_ADD}
          accessibilityLabel={tab === "notes" ? "New note" : "New task"}
          onPress={onAdd}
        />
      </Stack.Toolbar>

      <View style={styles.segment}>
        <Segment label="Notes" count={notes.length} active={tab === "notes"} onPress={() => setTab("notes")} t={t} />
        <Segment label="Board" count={cards.length} active={tab === "board"} onPress={() => setTab("board")} t={t} />
      </View>

      {tab === "notes" ? (
        notes.length === 0 ? (
          <Empty text="No notes yet. Tap + to create one." t={t} />
        ) : (
          <View style={{ flex: 1 }}>
            <NoteFilterBar
              filter={filter}
              onFilter={setFilter}
              tags={projectTags}
              activeTagId={activeTagId}
              onToggleTag={(tid) => setActiveTagId((cur) => (cur === tid ? null : tid))}
              t={t}
              styles={styles}
            />
            {isFiltering ? (
              filtered.length === 0 ? (
                <Empty text="No notes match your filter." t={t} />
              ) : (
                <ScrollView contentContainerStyle={styles.notesScroll} keyboardShouldPersistTaps="handled">
                  {filtered.map((n) => (
                    <NoteRowItem key={n.id} note={n} depth={0} onPress={() => router.push(noteHref(n.id))} t={t} />
                  ))}
                </ScrollView>
              )
            ) : (
              <ScrollView contentContainerStyle={styles.notesScroll} keyboardShouldPersistTaps="handled">
                {tree.folders.map((f) => (
                  <FolderTree
                    key={f.path}
                    node={f}
                    depth={0}
                    collapsed={collapsed}
                    onToggle={toggle}
                    onNote={(nid) => router.push(noteHref(nid))}
                    t={t}
                  />
                ))}
                {tree.rootNotes.map((n) => (
                  <NoteRowItem key={n.id} note={n} depth={0} onPress={() => router.push(noteHref(n.id))} t={t} />
                ))}
              </ScrollView>
            )}
          </View>
        )
      ) : (
        <DraggableBoard
          columns={columns}
          cards={cards}
          bottomInset={insets.bottom}
          onMove={(cardId, colId) => {
            moveCardToColumn(cardId, colId);
            load();
          }}
          onOpenCard={(cid) => router.push(cardHref(cid))}
          onAddCard={(colId) => router.push({ pathname: "/card/new", params: { project: id, column: colId } })}
        />
      )}
    </View>
  );
}

function NoteFilterBar({
  filter,
  onFilter,
  tags,
  activeTagId,
  onToggleTag,
  t,
  styles,
}: {
  filter: string;
  onFilter: (v: string) => void;
  tags: TagRow[];
  activeTagId: string | null;
  onToggleTag: (id: string) => void;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.filterWrap}>
      <SearchField value={filter} onChangeText={onFilter} placeholder="Filter notes…" />
      {tags.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tagFilterRow} keyboardShouldPersistTaps="handled">
          {tags.map((tag) => {
            const active = activeTagId === tag.id;
            return (
              <Pressable
                key={tag.id}
                onPress={() => onToggleTag(tag.id)}
                style={[
                  styles.tagFilterChip,
                  {
                    backgroundColor: active ? tag.color : withAlpha(tag.color, 0.14),
                    borderColor: active ? tag.color : withAlpha(tag.color, 0.35),
                  },
                ]}
              >
                {!active && <View style={[styles.tagFilterDot, { backgroundColor: tag.color }]} />}
                <Text style={[styles.tagFilterText, { color: active ? "#fff" : t.textSecondary }]} numberOfLines={1}>
                  {tag.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

function Segment({ label, count, active, onPress, t }: { label: string; count: number; active: boolean; onPress: () => void; t: Theme }) {
  return (
    <Pressable
      onPress={onPress}
      style={[{ flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center" }, active && { backgroundColor: t.surface }]}
    >
      <Text style={{ color: active ? t.textPrimary : t.textTertiary, fontWeight: active ? "600" : "400", fontSize: typeScale.label.fontSize }}>
        {label} <Text style={{ color: t.textTertiary }}>{count}</Text>
      </Text>
    </Pressable>
  );
}

function NoteRowItem({ note, depth, onPress, t }: { note: NoteRow; depth: number; onPress: () => void; t: Theme }) {
  // Mirror the desktop NoteListItem: title, a 1-line content preview, then a
  // meta row of relative time + up to 3 tag chips.
  const preview = useMemo(() => {
    const text = stripMarkdown(note.content ?? "").trim();
    return text ? text.slice(0, 80) : "Empty note";
  }, [note.content]);
  const tags = useMemo(() => tagsForNote(note).slice(0, 3), [note]);
  return (
    <PressableScale
      scaleTo={1}
      dimTo={0.5}
      onPress={onPress}
      style={{
        gap: 3,
        paddingVertical: 10,
        paddingRight: 14,
        paddingLeft: 14 + depth * 16,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: t.borderSubtle,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <FileText size={13} color={t.textTertiary} />
        {note.is_pinned ? <Pin size={11} color={t.accent} fill={t.accent} /> : null}
        <Text style={{ flex: 1, color: t.textPrimary, ...typeScale.control, fontWeight: "500" }} numberOfLines={1}>
          {note.title || "Untitled"}
        </Text>
      </View>
      <Text style={{ color: t.textTertiary, ...typeScale.caption, paddingLeft: 21 }} numberOfLines={1}>
        {preview}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 21 }}>
        <Text style={{ color: t.textTertiary, ...typeScale.micro, fontWeight: "400" }}>{formatRelative(note.updated_at)}</Text>
        {tags.length > 0 && <TagChips tags={tags} size="sm" />}
      </View>
    </PressableScale>
  );
}

function FolderTree({
  node,
  depth,
  collapsed,
  onToggle,
  onNote,
  t,
}: {
  node: FolderNode<NoteRow>;
  depth: number;
  collapsed: Record<string, boolean>;
  onToggle: (p: string) => void;
  onNote: (id: string) => void;
  t: Theme;
}) {
  const isCollapsed = collapsed[node.path];
  return (
    <View>
      <Pressable
        onPress={() => onToggle(node.path)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingVertical: 9,
          paddingRight: 14,
          paddingLeft: 12 + depth * 16,
          backgroundColor: t.surface2,
        }}
      >
        {isCollapsed ? <ChevronRight size={14} color={t.textTertiary} /> : <ChevronDown size={14} color={t.textTertiary} />}
        {isCollapsed ? <Folder size={14} color={t.accent} /> : <FolderOpen size={14} color={t.accent} />}
        <Text style={{ flex: 1, color: t.textSecondary, ...typeScale.label }} numberOfLines={1}>
          {node.name}
        </Text>
        <Text style={{ color: t.textTertiary, ...typeScale.micro, fontWeight: "400" }}>{node.notes.length}</Text>
      </Pressable>
      {!isCollapsed && (
        <>
          {node.children.map((child) => (
            <FolderTree key={child.path} node={child} depth={depth + 1} collapsed={collapsed} onToggle={onToggle} onNote={onNote} t={t} />
          ))}
          {node.notes.map((n) => (
            <NoteRowItem key={n.id} note={n} depth={depth + 1} onPress={() => onNote(n.id)} t={t} />
          ))}
        </>
      )}
    </View>
  );
}

function Empty({ text, t }: { text: string; t: Theme }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
        <Text style={{ ...typeScale.caption, color: t.textTertiary, textAlign: "center" }}>{text}</Text>
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.background },
    segment: { flexDirection: "row", gap: 4, margin: 12, padding: 4, backgroundColor: t.surface2, borderRadius: 10 },
    filterWrap: { paddingHorizontal: 12, paddingBottom: 8, gap: 8 },
    tagFilterRow: { gap: 8, paddingRight: 12 },
    tagFilterChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 5, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1 },
    tagFilterDot: { width: 7, height: 7, borderRadius: 4 },
    tagFilterText: { ...typeScale.label, maxWidth: 140 },
    notesScroll: { paddingBottom: 40 },
  });
}
