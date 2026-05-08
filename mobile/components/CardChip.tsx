import { View, Text, Pressable, Modal, ScrollView } from "react-native";
import { useState } from "react";
import { ChevronRight } from "lucide-react-native";
import type { TaskCard, BoardColumn } from "../../src/types/index";

const PRIORITY_COLORS: Record<TaskCard["priority"], string> = {
  low: "#3f3f46",
  medium: "#6366f1",
  high: "#f97316",
  urgent: "#ef4444",
};

const PRIORITY_LABELS: Record<TaskCard["priority"], string> = {
  low: "Low",
  medium: "Med",
  high: "High",
  urgent: "URGENT",
};

interface Props {
  card: TaskCard;
  columns: BoardColumn[];
  onMove: (cardId: string, columnId: string) => Promise<void>;
}

export function CardChip({ card, columns, onMove }: Props) {
  const [showMoveMenu, setShowMoveMenu] = useState(false);

  const currentColumn = columns.find((c) => c.id === card.columnId);
  const otherColumns = columns.filter((c) => c.id !== card.columnId);

  return (
    <>
      <Pressable
        onLongPress={() => setShowMoveMenu(true)}
        className="bg-zinc-800 rounded-xl p-3 gap-2 active:opacity-80"
      >
        <Text className="text-white text-sm font-medium leading-5">{card.title}</Text>

        <View className="flex-row items-center justify-between">
          {/* Priority badge */}
          <View
            className="px-1.5 py-0.5 rounded-md"
            style={{ backgroundColor: `${PRIORITY_COLORS[card.priority]}33` }}
          >
            <Text
              className="text-xs font-semibold"
              style={{ color: PRIORITY_COLORS[card.priority] }}
            >
              {PRIORITY_LABELS[card.priority]}
            </Text>
          </View>

          {card.dueDate && (
            <Text className="text-zinc-600 text-xs">
              {new Date(card.dueDate).toLocaleDateString()}
            </Text>
          )}

          <Pressable
            onPress={() => setShowMoveMenu(true)}
            className="active:opacity-70 ml-auto"
          >
            <ChevronRight color="#52525b" size={16} />
          </Pressable>
        </View>
      </Pressable>

      {/* Move menu */}
      <Modal visible={showMoveMenu} transparent animationType="fade">
        <Pressable
          className="flex-1 bg-black/60 items-center justify-center px-6"
          onPress={() => setShowMoveMenu(false)}
        >
          <Pressable className="w-full bg-zinc-900 rounded-2xl overflow-hidden">
            <View className="px-4 py-3 border-b border-zinc-800">
              <Text className="text-zinc-400 text-xs font-semibold uppercase tracking-wider">
                Move card
              </Text>
              <Text className="text-white font-semibold text-sm mt-1" numberOfLines={1}>
                {card.title}
              </Text>
            </View>

            <ScrollView>
              {otherColumns.map((col) => (
                <Pressable
                  key={col.id}
                  onPress={async () => {
                    setShowMoveMenu(false);
                    await onMove(card.id, col.id);
                  }}
                  className="px-4 py-3.5 border-b border-zinc-800/50 active:bg-zinc-800"
                >
                  <Text className="text-white text-sm">{col.name}</Text>
                </Pressable>
              ))}
            </ScrollView>

            <Pressable
              onPress={() => setShowMoveMenu(false)}
              className="px-4 py-3.5 items-center active:bg-zinc-800"
            >
              <Text className="text-zinc-500 text-sm">Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
