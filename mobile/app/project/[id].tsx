import { View, Text, Pressable, ScrollView, Modal, KeyboardAvoidingView, Platform, TextInput, RefreshControl } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState, useCallback } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { ArrowLeft, Plus, X } from "lucide-react-native";
import { useStore } from "../../store/index";
import { CardChip } from "../../components/CardChip";
import { NoteRow } from "../../components/NoteRow";
import type { BoardColumn, TaskCard } from "../../../src/types/index";

const COL_ACCENT: Record<string, string> = {
  backlog: "#666360", todo: "#60a5fa", in_progress: "#f59e0b", review: "#a78bfa", done: "#3ecf8e",
};

type Seg = "board" | "notes";

export default function ProjectDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [seg, setSeg] = useState<Seg>("board");
  const [refreshing, setRefreshing] = useState(false);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");

  const projects = useStore((s) => s.projects);
  const project = projects.find((p) => p.id === id);
  const columns = useStore((s) => s.columns);
  const cards = useStore((s) => s.cards);
  const notes = useStore((s) => s.notes);
  const loadBoard = useStore((s) => s.loadBoard);
  const loadNotes = useStore((s) => s.loadNotes);
  const createCard = useStore((s) => s.createCard);
  const moveCard = useStore((s) => s.moveCard);

  useEffect(() => { if (id) { loadBoard(id); loadNotes(id); } }, [id]);

  const onRefresh = useCallback(async () => {
    if (!id) return;
    setRefreshing(true);
    await Promise.all([loadBoard(id), loadNotes(id)]);
    setRefreshing(false);
  }, [id]);

  const cardsFor = (colId: string) => cards.filter((c) => c.columnId === colId && !c.archivedAt);

  async function addCard() {
    if (!newTitle.trim() || !addingTo || !project) return;
    await createCard(project.id, project.workspaceId, addingTo, newTitle.trim());
    setNewTitle("");
    setAddingTo(null);
  }

  if (!project) return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#0d0d0d", alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: "#66635f" }}>Project not found</Text>
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#0d0d0d" }} edges={["top"]}>
      {/* Header */}
      <View style={{
        flexDirection: "row", alignItems: "center",
        paddingHorizontal: 16, paddingVertical: 10,
        gap: 10, borderBottomWidth: 1, borderBottomColor: "#2a2a2a",
      }}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft color="#66635f" size={18} />
        </Pressable>
        <Text numberOfLines={1} style={{ flex: 1, color: "#9e9a94", fontSize: 13, fontWeight: "600" }}>
          {project.icon ? `${project.icon} ` : ""}{project.name}
        </Text>
      </View>

      {/* Segment */}
      <View style={{
        flexDirection: "row",
        marginHorizontal: 12, marginVertical: 8,
        backgroundColor: "#141414",
        borderRadius: 8, padding: 2, gap: 2,
        borderWidth: 1, borderColor: "#2a2a2a",
      }}>
        {(["board", "notes"] as Seg[]).map((s) => (
          <Pressable
            key={s}
            onPress={() => setSeg(s)}
            style={{
              flex: 1, paddingVertical: 6, borderRadius: 6, alignItems: "center",
              backgroundColor: seg === s ? "#222" : "transparent",
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: "500", textTransform: "capitalize", color: seg === s ? "#e8e4dc" : "#66635f" }}>{s}</Text>
          </Pressable>
        ))}
      </View>

      {seg === "board" && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 10 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#7c6af7" />}
        >
          {columns.map((col) => (
            <Column
              key={col.id}
              column={col}
              cards={cardsFor(col.id)}
              allColumns={columns}
              accent={COL_ACCENT[col.type] ?? "#666360"}
              onAdd={() => setAddingTo(col.id)}
              onMove={moveCard}
            />
          ))}
        </ScrollView>
      )}

      {seg === "notes" && (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#7c6af7" />}
        >
          {notes.length === 0 ? (
            <View style={{ alignItems: "center", paddingVertical: 60 }}>
              <Text style={{ color: "#66635f", fontSize: 13 }}>No notes in this project.</Text>
            </View>
          ) : notes.map((n) => <NoteRow key={n.id} note={n} onPress={() => router.push(`/note/${n.id}`)} />)}
        </ScrollView>
      )}

      {/* Add card modal */}
      <Modal visible={!!addingTo} transparent animationType="slide">
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1, justifyContent: "flex-end" }}>
          <View style={{ backgroundColor: "#141414", borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, gap: 14, borderTopWidth: 1, borderColor: "#2a2a2a" }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={{ color: "#e8e4dc", fontSize: 15, fontWeight: "600" }}>New card</Text>
              <Pressable onPress={() => { setAddingTo(null); setNewTitle(""); }} hitSlop={8}>
                <X color="#66635f" size={18} />
              </Pressable>
            </View>
            <TextInput
              style={{ backgroundColor: "#1a1a1a", borderRadius: 8, borderWidth: 1, borderColor: "#2a2a2a", paddingHorizontal: 12, paddingVertical: 10, color: "#e8e4dc", fontSize: 14 }}
              placeholder="Card title…"
              placeholderTextColor="#3a3835"
              value={newTitle}
              onChangeText={setNewTitle}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={addCard}
            />
            <Pressable
              onPress={addCard}
              style={({ pressed }) => ({ backgroundColor: "#7c6af7", borderRadius: 8, paddingVertical: 12, alignItems: "center", opacity: pressed ? 0.8 : 1 })}
            >
              <Text style={{ color: "#fff", fontSize: 14, fontWeight: "600" }}>Add card</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

function Column({ column, cards, allColumns, accent, onAdd, onMove }: {
  column: BoardColumn; cards: TaskCard[]; allColumns: BoardColumn[];
  accent: string; onAdd: () => void; onMove: (id: string, col: string) => Promise<void>;
}) {
  return (
    <View style={{
      width: 224,
      backgroundColor: "#141414",
      borderRadius: 12,
      borderWidth: 1,
      borderColor: "#2a2a2a",
      flexShrink: 0,
      overflow: "hidden",
    }}>
      {/* Column header */}
      <View style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 9,
        borderBottomWidth: 1,
        borderBottomColor: "#2a2a2a",
      }}>
        {/* Colour dot */}
        <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: accent, flexShrink: 0 }} />
        {/* Name */}
        <Text
          numberOfLines={1}
          style={{ color: "#9e9a94", fontSize: 11, fontWeight: "600", flex: 1 }}
        >
          {column.name}
        </Text>
        {/* Card count badge */}
        <View style={{ paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, backgroundColor: "#222" }}>
          <Text style={{ color: "#66635f", fontSize: 10, fontFamily: "monospace" }}>{cards.length}</Text>
        </View>
        {/* Add button */}
        <Pressable onPress={onAdd} hitSlop={8} style={{ padding: 2 }}>
          <Plus color="#7c6af7" size={13} />
        </Pressable>
      </View>

      {/* Cards */}
      <View style={{ padding: 8, gap: 6 }}>
        {cards.map((c) => <CardChip key={c.id} card={c} columns={allColumns} onMove={onMove} />)}
        {cards.length === 0 && (
          <View style={{
            height: 48,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: "#1f1f1f",
            borderStyle: "dashed",
            alignItems: "center",
            justifyContent: "center",
          }}>
            <Text style={{ color: "#3a3835", fontSize: 11 }}>Drop here or add card</Text>
          </View>
        )}
      </View>

      {/* Add card footer */}
      <Pressable
        onPress={onAdd}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          paddingHorizontal: 10,
          paddingVertical: 9,
          borderTopWidth: 1,
          borderTopColor: "#2a2a2a",
          backgroundColor: pressed ? "#1a1a1a" : "transparent",
        })}
      >
        <Plus color="#66635f" size={12} />
        <Text style={{ color: "#66635f", fontSize: 12 }}>Add card</Text>
      </Pressable>
    </View>
  );
}
