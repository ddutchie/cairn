import { useCallback, useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, LayoutAnimation, TextInput } from "react-native";
import { useLocalSearchParams, useRouter, useFocusEffect, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronDown, ChevronRight, Folder, FolderOpen, FileText, Plus, Pin, Search, X } from "lucide-react-native";
import {
  getProject,
  listNotes,
  listColumns,
  listCards,
  moveCardToColumn,
  tagsForCard,
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
import { useDataChanged } from "@/sync/useSyncStatus";
import { useTheme, withAlpha, PRIORITY_COLOR, elevation, type Theme } from "@/theme";
import { buildFolderTree, type FolderNode } from "@cairn/shared/notes/folder-tree";
import { stripMarkdown } from "@cairn/shared/notes/text";
import { formatRelative } from "@cairn/shared/format/date";

type Tab = "notes" | "board";

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
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
    if (tab === "notes") router.push(`/note/new?project=${id}`);
    else router.push(`/card/new?project=${id}`);
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: project?.name || "Project",
          headerBackTitle: "Projects",
          headerRight: () => (
            <Pressable onPress={onAdd} hitSlop={12}>
              <Plus size={22} color={t.accent} />
            </Pressable>
          ),
        }}
      />

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
                    <NoteRowItem key={n.id} note={n} depth={0} onPress={() => router.push(`/note/${n.id}`)} t={t} />
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
                    onNote={(nid) => router.push(`/note/${nid}`)}
                    t={t}
                  />
                ))}
                {tree.rootNotes.map((n) => (
                  <NoteRowItem key={n.id} note={n} depth={0} onPress={() => router.push(`/note/${n.id}`)} t={t} />
                ))}
              </ScrollView>
            )}
          </View>
        )
      ) : (
        <BoardView
          columns={columns}
          cards={cards}
          t={t}
          styles={styles}
          bottomInset={insets.bottom}
          onMove={(cardId, colId) => {
            // Animate the card sliding between columns instead of teleporting.
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            moveCardToColumn(cardId, colId);
            load();
          }}
          onOpenCard={(cid) => router.push(`/card/${cid}`)}
          onAddCard={(colId) => router.push(`/card/new?project=${id}&column=${colId}`)}
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
      <View style={styles.filterInputRow}>
        <Search size={15} color={t.textTertiary} />
        <TextInput
          style={styles.filterInput}
          value={filter}
          onChangeText={onFilter}
          placeholder="Filter notes…"
          placeholderTextColor={t.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {filter ? (
          <Pressable onPress={() => onFilter("")} hitSlop={8}>
            <X size={15} color={t.textTertiary} />
          </Pressable>
        ) : null}
      </View>
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
      <Text style={{ color: active ? t.textPrimary : t.textTertiary, fontWeight: active ? "600" : "400", fontSize: 14 }}>
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
        <Text style={{ flex: 1, color: t.textPrimary, fontSize: 14, fontWeight: "500" }} numberOfLines={1}>
          {note.title || "Untitled"}
        </Text>
      </View>
      <Text style={{ color: t.textTertiary, fontSize: 12, paddingLeft: 21 }} numberOfLines={1}>
        {preview}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 21 }}>
        <Text style={{ color: t.textTertiary, fontSize: 11 }}>{formatRelative(note.updated_at)}</Text>
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
        <Text style={{ flex: 1, color: t.textSecondary, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>
          {node.name}
        </Text>
        <Text style={{ color: t.textTertiary, fontSize: 11 }}>{node.notes.length}</Text>
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

function BoardView({
  columns,
  cards,
  t,
  styles,
  bottomInset,
  onMove,
  onOpenCard,
  onAddCard,
}: {
  columns: ColumnRow[];
  cards: CardRow[];
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
  bottomInset: number;
  onMove: (cardId: string, colId: string) => void;
  onOpenCard: (id: string) => void;
  onAddCard: (colId: string) => void;
}) {
  if (columns.length === 0) return <Empty text="No board columns in this project." t={t} />;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.board, { paddingBottom: 12 + bottomInset }]}
      style={styles.boardScroll}
    >
      {columns.map((col, colIdx) => {
        const colCards = cards.filter((c) => c.column_id === col.id);
        const prevCol = columns[colIdx - 1];
        const nextCol = columns[colIdx + 1];
        return (
          <View key={col.id} style={styles.column}>
            <Text style={styles.columnTitle}>
              {col.name} <Text style={styles.count}>{colCards.length}</Text>
            </Text>
            <ScrollView style={styles.columnCards} showsVerticalScrollIndicator={false}>
              {colCards.map((card) => (
                <CardItem
                  key={card.id}
                  card={card}
                  t={t}
                  styles={styles}
                  canLeft={!!prevCol}
                  canRight={!!nextCol}
                  onLeft={() => prevCol && onMove(card.id, prevCol.id)}
                  onRight={() => nextCol && onMove(card.id, nextCol.id)}
                  onOpen={onOpenCard}
                />
              ))}
              <Pressable style={styles.addCard} onPress={() => onAddCard(col.id)}>
                <Plus size={14} color={t.textTertiary} />
                <Text style={styles.addCardText}>New task</Text>
              </Pressable>
            </ScrollView>
          </View>
        );
      })}
    </ScrollView>
  );
}

function CardItem({
  card,
  t,
  styles,
  canLeft,
  canRight,
  onLeft,
  onRight,
  onOpen,
}: {
  card: CardRow;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
  canLeft: boolean;
  canRight: boolean;
  onLeft: () => void;
  onRight: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <PressableScale style={[styles.card, elevation.sm]} onPress={() => onOpen(card.id)}>
      <View style={styles.cardTop}>
        <View style={[styles.priorityDot, { backgroundColor: PRIORITY_COLOR[card.priority] ?? t.accent }]} />
        <Text style={styles.cardTitle}>{card.title}</Text>
      </View>
      {card.description ? (
        <Text style={styles.cardDesc} numberOfLines={2}>
          {stripMarkdown(card.description)}
        </Text>
      ) : null}
      <CardTags card={card} />
      <View style={styles.cardActions}>
        <Pressable disabled={!canLeft} onPress={onLeft} hitSlop={6} style={[styles.moveBtn, !canLeft && styles.moveBtnDisabled]}>
          <Text style={styles.moveBtnText}>←</Text>
        </Pressable>
        <Pressable disabled={!canRight} onPress={onRight} hitSlop={6} style={[styles.moveBtn, !canRight && styles.moveBtnDisabled]}>
          <Text style={styles.moveBtnText}>→</Text>
        </Pressable>
      </View>
    </PressableScale>
  );
}

function Empty({ text, t }: { text: string; t: Theme }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
      <Text style={{ fontSize: 13, color: t.textTertiary, textAlign: "center" }}>{text}</Text>
    </View>
  );
}

function CardTags({ card }: { card: CardRow }) {
  const tags = tagsForCard(card);
  if (!tags.length) return null;
  return (
    <View style={{ marginTop: 8 }}>
      <TagChips tags={tags} size="sm" />
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.background },
    segment: { flexDirection: "row", gap: 4, margin: 12, padding: 4, backgroundColor: t.surface2, borderRadius: 10 },
    filterWrap: { paddingHorizontal: 12, paddingBottom: 8, gap: 8 },
    filterInputRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      height: 38,
      backgroundColor: t.surface2,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border,
    },
    filterInput: { flex: 1, color: t.textPrimary, fontSize: 14, padding: 0 },
    tagFilterRow: { gap: 8, paddingRight: 12 },
    tagFilterChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 5, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1 },
    tagFilterDot: { width: 7, height: 7, borderRadius: 4 },
    tagFilterText: { fontSize: 13, fontWeight: "600", maxWidth: 140 },
    notesScroll: { paddingBottom: 40 },
    // The horizontal board scroller fills the remaining vertical space; its
    // content stretches column height to match so columns reach the bottom.
    boardScroll: { flex: 1 },
    board: { padding: 12, paddingTop: 0, gap: 12, flexDirection: "row", alignItems: "stretch", flexGrow: 1 },
    column: { width: 260, backgroundColor: t.surface, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: t.border },
    // Card list grows to fill the column and scrolls internally when overflowing.
    columnCards: { flex: 1 },
    columnTitle: { fontSize: 14, fontWeight: "700", color: t.textPrimary, marginBottom: 8 },
    count: { color: t.textTertiary, fontWeight: "400" },
    card: { backgroundColor: t.surface2, borderRadius: 8, padding: 10, marginBottom: 8, borderWidth: 1, borderColor: t.borderSubtle },
    addCard: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: t.border, borderStyle: "dashed", marginTop: 2 },
    addCardText: { fontSize: 13, color: t.textTertiary, fontWeight: "600" },
    cardTop: { flexDirection: "row", alignItems: "center", gap: 8 },
    priorityDot: { width: 8, height: 8, borderRadius: 4 },
    cardTitle: { flex: 1, fontSize: 13, color: t.textPrimary, fontWeight: "500" },
    cardDesc: { fontSize: 12, color: t.textSecondary, marginTop: 8, lineHeight: 17 },
    cardActions: { flexDirection: "row", gap: 8, marginTop: 10 },
    moveBtn: { flex: 1, paddingVertical: 6, borderRadius: 6, backgroundColor: t.surface3, alignItems: "center" },
    moveBtnDisabled: { opacity: 0.35 },
    moveBtnText: { fontSize: 12, color: t.textPrimary, fontWeight: "600" },
  });
}
