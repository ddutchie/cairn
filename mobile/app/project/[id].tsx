/**
 * Project detail — segmented view with Board and Notes tabs.
 */
import { View, Text, Pressable, ScrollView, FlatList, RefreshControl, TextInput, Modal, KeyboardAvoidingView, Platform } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState, useCallback } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { ArrowLeft, Plus, X } from "lucide-react-native";
import { useStore } from "../../store/index";
import { CardChip } from "../../components/CardChip";
import { NoteRow } from "../../components/NoteRow";
import type { BoardColumn, TaskCard } from "../../../src/types/index";

type Segment = "board" | "notes";

export default function ProjectDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [segment, setSegment] = useState<Segment>("board");
  const [refreshing, setRefreshing] = useState(false);
  const [addingToColumn, setAddingToColumn] = useState<string | null>(null);
  const [newCardTitle, setNewCardTitle] = useState("");

  const projects = useStore((s) => s.projects);
  const project = projects.find((p) => p.id === id);

  const columns = useStore((s) => s.columns);
  const cards = useStore((s) => s.cards);
  const notes = useStore((s) => s.notes);

  const loadBoard = useStore((s) => s.loadBoard);
  const loadNotes = useStore((s) => s.loadNotes);
  const createCard = useStore((s) => s.createCard);
  const moveCard = useStore((s) => s.moveCard);

  useEffect(() => {
    if (id) {
      loadBoard(id);
      loadNotes(id);
    }
  }, [id]);

  const onRefresh = useCallback(async () => {
    if (!id) return;
    setRefreshing(true);
    await Promise.all([loadBoard(id), loadNotes(id)]);
    setRefreshing(false);
  }, [id]);

  const cardsForColumn = (colId: string) =>
    cards.filter((c) => c.columnId === colId && !c.archivedAt);

  async function handleAddCard() {
    if (!newCardTitle.trim() || !addingToColumn || !project) return;
    await createCard(project.id, project.workspaceId, addingToColumn, newCardTitle.trim());
    setNewCardTitle("");
    setAddingToColumn(null);
  }

  if (!project) {
    return (
      <SafeAreaView className="flex-1 bg-zinc-950 items-center justify-center">
        <Text className="text-zinc-500">Project not found</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-zinc-950" edges={["top"]}>
      {/* Header */}
      <View className="flex-row items-center gap-3 px-4 pt-2 pb-3">
        <Pressable onPress={() => router.back()} className="active:opacity-70">
          <ArrowLeft color="#a1a1aa" size={22} />
        </Pressable>
        <View className="flex-1">
          <Text className="text-white font-bold text-lg" numberOfLines={1}>
            {project.icon ? `${project.icon} ` : ""}{project.name}
          </Text>
        </View>
      </View>

      {/* Segment control */}
      <View className="flex-row mx-4 mb-3 bg-zinc-900 rounded-xl p-1 gap-1">
        {(["board", "notes"] as Segment[]).map((s) => (
          <Pressable
            key={s}
            onPress={() => setSegment(s)}
            className={`flex-1 py-2 rounded-lg items-center ${segment === s ? "bg-zinc-700" : ""}`}
          >
            <Text
              className={`text-sm font-semibold capitalize ${
                segment === s ? "text-white" : "text-zinc-500"
              }`}
            >
              {s}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Board view */}
      {segment === "board" && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="px-4 pb-8 gap-3"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#6366f1" />
          }
        >
          {columns.map((col) => (
            <KanbanColumn
              key={col.id}
              column={col}
              cards={cardsForColumn(col.id)}
              allColumns={columns}
              onAddCard={() => setAddingToColumn(col.id)}
              onMoveCard={moveCard}
            />
          ))}
        </ScrollView>
      )}

      {/* Notes view */}
      {segment === "notes" && (
        <ScrollView
          className="flex-1"
          contentContainerClassName="px-4 pb-8"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#6366f1" />
          }
        >
          {notes.length === 0 && (
            <View className="items-center py-16">
              <Text className="text-zinc-600 text-base">No notes in this project.</Text>
            </View>
          )}
          {notes.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              onPress={() => router.push(`/note/${note.id}`)}
            />
          ))}
        </ScrollView>
      )}

      {/* Add card modal */}
      <Modal visible={!!addingToColumn} transparent animationType="slide">
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          className="flex-1 justify-end"
        >
          <View className="bg-zinc-900 rounded-t-2xl p-5 gap-4">
            <View className="flex-row items-center justify-between">
              <Text className="text-white font-semibold text-base">Add card</Text>
              <Pressable
                onPress={() => { setAddingToColumn(null); setNewCardTitle(""); }}
                className="active:opacity-70"
              >
                <X color="#71717a" size={20} />
              </Pressable>
            </View>
            <TextInput
              className="bg-zinc-800 rounded-xl px-4 py-3 text-white text-sm"
              placeholder="Card title…"
              placeholderTextColor="#52525b"
              value={newCardTitle}
              onChangeText={setNewCardTitle}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleAddCard}
            />
            <Pressable
              onPress={handleAddCard}
              className="bg-indigo-600 rounded-xl py-3 items-center active:opacity-80"
            >
              <Text className="text-white font-semibold text-sm">Add card</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

// ── Kanban Column ─────────────────────────────────────────────────────────────

function KanbanColumn({
  column,
  cards,
  allColumns,
  onAddCard,
  onMoveCard,
}: {
  column: BoardColumn;
  cards: TaskCard[];
  allColumns: BoardColumn[];
  onAddCard: () => void;
  onMoveCard: (cardId: string, colId: string) => Promise<void>;
}) {
  return (
    <View className="w-72 bg-zinc-900 rounded-2xl p-3">
      {/* Column header */}
      <View className="flex-row items-center justify-between mb-2 px-1">
        <View className="flex-row items-center gap-2">
          <Text className="text-white font-semibold text-sm">{column.name}</Text>
          <View className="bg-zinc-700 rounded-full px-2 py-0.5">
            <Text className="text-zinc-400 text-xs">{cards.length}</Text>
          </View>
        </View>
        <Pressable onPress={onAddCard} className="active:opacity-70">
          <Plus color="#6366f1" size={18} />
        </Pressable>
      </View>

      {/* Cards */}
      <View className="gap-2">
        {cards.map((card) => (
          <CardChip
            key={card.id}
            card={card}
            columns={allColumns}
            onMove={onMoveCard}
          />
        ))}
        {cards.length === 0 && (
          <Text className="text-zinc-700 text-xs text-center py-4">Empty</Text>
        )}
      </View>
    </View>
  );
}
