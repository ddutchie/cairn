import { View, Text, Pressable, Modal, ScrollView } from "react-native";
import { useState } from "react";
import { MoveRight } from "lucide-react-native";
import type { TaskCard, BoardColumn } from "../../src/types/index";

const PRIORITY_COLOR: Record<TaskCard["priority"], string> = {
  low:    "#66635f",
  medium: "#7c6af7",
  high:   "#f97316",
  urgent: "#ef4444",
};

const PRIORITY_LABEL: Record<TaskCard["priority"], string> = {
  low: "Low", medium: "Med", high: "High", urgent: "!!",
};

export function CardChip({ card, columns, onMove }: {
  card: TaskCard;
  columns: BoardColumn[];
  onMove: (cardId: string, columnId: string) => Promise<void>;
}) {
  const [showMove, setShowMove] = useState(false);
  const others = columns.filter((c) => c.id !== card.columnId);
  const pc = PRIORITY_COLOR[card.priority];

  return (
    <>
      <Pressable
        onLongPress={() => setShowMove(true)}
        style={({ pressed }) => ({
          backgroundColor: pressed ? "#222" : "#1a1a1a",
          borderRadius: 10,
          borderWidth: 1,
          borderColor: "#2a2a2a",
          padding: 12,
          gap: 8,
        })}
      >
        <Text style={{ color: "#e8e4dc", fontSize: 13, fontWeight: "500", lineHeight: 18 }}>
          {card.title}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {/* Priority pill */}
          <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: `${pc}20` }}>
            <Text style={{ color: pc, fontSize: 10, fontWeight: "600" }}>
              {PRIORITY_LABEL[card.priority]}
            </Text>
          </View>
          {card.dueDate && (
            <Text style={{ color: "#66635f", fontSize: 11 }}>
              {new Date(card.dueDate).toLocaleDateString()}
            </Text>
          )}
          <Pressable onPress={() => setShowMove(true)} style={{ marginLeft: "auto" }}>
            <MoveRight color="#3a3835" size={14} />
          </Pressable>
        </View>
      </Pressable>

      <Modal visible={showMove} transparent animationType="fade">
        <Pressable
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "center", alignItems: "center", paddingHorizontal: 24 }}
          onPress={() => setShowMove(false)}
        >
          <Pressable style={{ width: "100%", backgroundColor: "#141414", borderRadius: 14, borderWidth: 1, borderColor: "#2a2a2a", overflow: "hidden" }}>
            <View style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: "#1f1f1f" }}>
              <Text style={{ color: "#66635f", fontSize: 10, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>
                Move to
              </Text>
              <Text numberOfLines={1} style={{ color: "#e8e4dc", fontSize: 14, fontWeight: "600" }}>
                {card.title}
              </Text>
            </View>
            <ScrollView>
              {others.map((col) => (
                <Pressable
                  key={col.id}
                  onPress={async () => { setShowMove(false); await onMove(card.id, col.id); }}
                  style={({ pressed }) => ({
                    paddingVertical: 14,
                    paddingHorizontal: 16,
                    borderBottomWidth: 1,
                    borderBottomColor: "#1f1f1f",
                    backgroundColor: pressed ? "#1a1a1a" : "transparent",
                  })}
                >
                  <Text style={{ color: "#e8e4dc", fontSize: 14 }}>{col.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              onPress={() => setShowMove(false)}
              style={({ pressed }) => ({ padding: 14, alignItems: "center", backgroundColor: pressed ? "#1a1a1a" : "transparent" })}
            >
              <Text style={{ color: "#66635f", fontSize: 14 }}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
