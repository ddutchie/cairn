import { View, Text, Pressable, Modal, ScrollView, StyleSheet } from "react-native";
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

const COL_ACCENT: Record<string, string> = {
  backlog: "#666360", todo: "#60a5fa", in_progress: "#f59e0b", review: "#a78bfa", done: "#3ecf8e",
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

      <Modal visible={showMove} transparent animationType="fade" statusBarTranslucent>
        <View style={StyleSheet.absoluteFillObject}>
          {/* Full-screen dim */}
          <View style={[StyleSheet.absoluteFillObject, { backgroundColor: "rgba(0,0,0,0.82)" }]} />
          {/* Tap outside to dismiss */}
          <Pressable style={StyleSheet.absoluteFillObject} onPress={() => setShowMove(false)} />
          {/* Modal card — centred on top */}
          <View style={{ flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 32 }}>
          <View style={{ width: "100%", backgroundColor: "#141414", borderRadius: 14, borderWidth: 1, borderColor: "#2a2a2a", overflow: "hidden" }}>
            {/* Title row */}
            <View style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: "#2a2a2a" }}>
              <Text style={{ color: "#66635f", fontSize: 10, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>
                Move to
              </Text>
              <Text numberOfLines={1} style={{ color: "#e8e4dc", fontSize: 14, fontWeight: "600" }}>
                {card.title}
              </Text>
            </View>

            {/* Column options */}
            <ScrollView bounces={false}>
              {others.map((col, i) => (
                <Pressable
                  key={col.id}
                  onPress={async () => { setShowMove(false); await onMove(card.id, col.id); }}
                  style={({ pressed }) => ({
                    paddingVertical: 13,
                    paddingHorizontal: 16,
                    backgroundColor: pressed ? "#1a1a1a" : "transparent",
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: "#1f1f1f",
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                  })}
                >
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: COL_ACCENT[col.type] ?? "#666360" }} />
                  <Text style={{ color: "#e8e4dc", fontSize: 14 }}>{col.name}</Text>
                </Pressable>
              ))}
            </ScrollView>

            {/* Cancel — separate section */}
            <Pressable
              onPress={() => setShowMove(false)}
              style={({ pressed }) => ({
                paddingVertical: 13,
                alignItems: "center",
                borderTopWidth: 1,
                borderTopColor: "#2a2a2a",
                backgroundColor: pressed ? "#1a1a1a" : "transparent",
              })}
            >
              <Text style={{ color: "#9e9a94", fontSize: 14 }}>Cancel</Text>
            </Pressable>
          </View>
          </View>
        </View>
      </Modal>
    </>
  );
}
