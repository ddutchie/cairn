import { useCallback, useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter, useFocusEffect, Stack } from "expo-router";
import { ChevronDown, ChevronRight, Folder, FolderOpen, FileText } from "lucide-react-native";
import {
  getProject,
  listNotes,
  listColumns,
  listCards,
  moveCardToColumn,
  type NoteRow,
  type CardRow,
  type ColumnRow,
} from "@/db/queries";
import { useTheme, PRIORITY_COLOR, type Theme } from "@/theme";
import { buildFolderTree, type FolderNode } from "@cairn/shared/notes/folder-tree";

type Tab = "notes" | "board";

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const t = useTheme();
  const [tab, setTab] = useState<Tab>("notes");
  const [project, setProject] = useState(id ? getProject(id) : null);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [columns, setColumns] = useState<ColumnRow[]>([]);
  const [cards, setCards] = useState<CardRow[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const load = useCallback(() => {
    if (!id) return;
    setProject(getProject(id));
    setNotes(listNotes(id));
    setColumns(listColumns(id));
    setCards(listCards(id));
  }, [id]);

  useFocusEffect(useCallback(() => load(), [load]));

  const tree = useMemo(() => buildFolderTree(notes), [notes]);
  const styles = useMemo(() => makeStyles(t), [t]);
  const toggle = (path: string) => setCollapsed((c) => ({ ...c, [path]: !c[path] }));

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: project?.name || "Project", headerBackTitle: "Projects" }} />

      <View style={styles.segment}>
        <Segment label="Notes" count={notes.length} active={tab === "notes"} onPress={() => setTab("notes")} t={t} />
        <Segment label="Board" count={cards.length} active={tab === "board"} onPress={() => setTab("board")} t={t} />
      </View>

      {tab === "notes" ? (
        notes.length === 0 ? (
          <Empty text="No notes in this project." t={t} />
        ) : (
          <ScrollView contentContainerStyle={styles.notesScroll}>
            {tree.rootNotes.map((n) => (
              <NoteRowItem key={n.id} note={n} depth={0} onPress={() => router.push(`/note/${n.id}`)} t={t} />
            ))}
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
          </ScrollView>
        )
      ) : (
        <BoardView
          columns={columns}
          cards={cards}
          t={t}
          styles={styles}
          onMove={(cardId, colId) => {
            moveCardToColumn(cardId, colId);
            load();
          }}
          onOpenNote={(nid) => router.push(`/note/${nid}`)}
        />
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
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingVertical: 10,
        paddingRight: 14,
        paddingLeft: 14 + depth * 16,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: t.borderSubtle,
      }}
    >
      <FileText size={13} color={t.textTertiary} />
      <Text style={{ flex: 1, color: t.textPrimary, fontSize: 14 }} numberOfLines={1}>
        {note.title || "Untitled"}
      </Text>
    </Pressable>
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
  onMove,
  onOpenNote,
}: {
  columns: ColumnRow[];
  cards: CardRow[];
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
  onMove: (cardId: string, colId: string) => void;
  onOpenNote: (id: string) => void;
}) {
  if (columns.length === 0) return <Empty text="No board columns in this project." t={t} />;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.board}>
      {columns.map((col, colIdx) => {
        const colCards = cards.filter((c) => c.column_id === col.id);
        const prevCol = columns[colIdx - 1];
        const nextCol = columns[colIdx + 1];
        return (
          <View key={col.id} style={styles.column}>
            <Text style={styles.columnTitle}>
              {col.name} <Text style={styles.count}>{colCards.length}</Text>
            </Text>
            <ScrollView style={{ maxHeight: 560 }}>
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
                  onOpenNote={onOpenNote}
                />
              ))}
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
}: {
  card: CardRow;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
  canLeft: boolean;
  canRight: boolean;
  onLeft: () => void;
  onRight: () => void;
  onOpenNote: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable style={styles.card} onPress={() => setOpen((o) => !o)}>
      <View style={styles.cardTop}>
        <View style={[styles.priorityDot, { backgroundColor: PRIORITY_COLOR[card.priority] ?? t.accent }]} />
        <Text style={styles.cardTitle}>{card.title}</Text>
      </View>
      {open && (
        <>
          {card.description ? (
            <Text style={styles.cardDesc} numberOfLines={4}>
              {card.description.replace(/[#*_`>[\]()!-]/g, "").trim()}
            </Text>
          ) : null}
          <View style={styles.cardActions}>
            <Pressable disabled={!canLeft} onPress={onLeft} style={[styles.moveBtn, !canLeft && styles.moveBtnDisabled]}>
              <Text style={styles.moveBtnText}>← Move</Text>
            </Pressable>
            <Pressable disabled={!canRight} onPress={onRight} style={[styles.moveBtn, !canRight && styles.moveBtnDisabled]}>
              <Text style={styles.moveBtnText}>Move →</Text>
            </Pressable>
          </View>
        </>
      )}
    </Pressable>
  );
}

function Empty({ text, t }: { text: string; t: Theme }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
      <Text style={{ fontSize: 13, color: t.textTertiary, textAlign: "center" }}>{text}</Text>
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.background },
    segment: { flexDirection: "row", gap: 4, margin: 12, padding: 4, backgroundColor: t.surface2, borderRadius: 10 },
    notesScroll: { paddingBottom: 40 },
    board: { padding: 12, paddingTop: 0, gap: 12, flexDirection: "row", alignItems: "flex-start" },
    column: { width: 260, backgroundColor: t.surface, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: t.border },
    columnTitle: { fontSize: 14, fontWeight: "700", color: t.textPrimary, marginBottom: 8 },
    count: { color: t.textTertiary, fontWeight: "400" },
    card: { backgroundColor: t.surface2, borderRadius: 8, padding: 10, marginBottom: 8, borderWidth: 1, borderColor: t.borderSubtle },
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
