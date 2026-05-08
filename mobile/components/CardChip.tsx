import { View, Text, Pressable, Modal, ScrollView, StyleSheet } from "react-native";
import { useState } from "react";
import { Calendar, FileText } from "lucide-react-native";
import type { TaskCard, BoardColumn } from "../../src/types/index";

const PRIORITY_COLOR: Record<TaskCard["priority"], string> = {
  low:    "#66635f",
  medium: "#7c6af7",
  high:   "#f97316",
  urgent: "#ef4444",
};

const COL_ACCENT: Record<string, string> = {
  backlog:     "#666360",
  todo:        "#60a5fa",
  in_progress: "#f59e0b",
  review:      "#a78bfa",
  done:        "#3ecf8e",
};

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getDueDateStatus(dateStr: string): "overdue" | "today" | "upcoming" {
  const now = new Date();
  const due = new Date(dateStr);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  if (dueDay < today) return "overdue";
  if (dueDay.getTime() === today.getTime()) return "today";
  return "upcoming";
}

export function CardChip({ card, columns, onMove }: {
  card: TaskCard;
  columns: BoardColumn[];
  onMove: (cardId: string, columnId: string) => Promise<void>;
}) {
  const [showMove, setShowMove] = useState(false);
  const others = columns.filter((c) => c.id !== card.columnId);
  const priorityColor = PRIORITY_COLOR[card.priority];
  const isBlocked = (card.blockedByIds ?? []).length > 0;
  const linkedCount = (card.linkedNoteIds ?? []).length;

  const hasFooter = !!(card.dueDate || linkedCount > 0 || isBlocked);

  return (
    <>
      <Pressable
        onLongPress={() => setShowMove(true)}
        onPress={() => setShowMove(true)}
        style={({ pressed }) => ({
          backgroundColor: pressed ? "#222" : "#1a1a1a",
          borderRadius: 8,
          borderWidth: 1,
          borderColor: "#2a2a2a",
          overflow: "hidden",
          position: "relative",
        })}
      >
        {/* Priority bar — absolute left edge */}
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: 3,
            bottom: 0,
            backgroundColor: priorityColor,
            opacity: 0.6,
          }}
        />

        <View style={{ paddingLeft: 10, paddingRight: 12, paddingTop: 10, paddingBottom: 10 }}>
          {/* Title */}
          <Text
            style={{
              color: "#9e9a94",
              fontSize: 13,
              fontWeight: "500",
              lineHeight: 18,
            }}
          >
            {card.title}
          </Text>

          {/* Description */}
          {!!card.description && (
            <Text
              numberOfLines={2}
              style={{
                color: "#66635f",
                fontSize: 11,
                lineHeight: 16,
                marginTop: 4,
              }}
            >
              {card.description}
            </Text>
          )}

          {/* Footer */}
          {hasFooter && (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                marginTop: 8,
                paddingTop: 8,
                borderTopWidth: 1,
                borderTopColor: "#1f1f1f",
              }}
            >
              {isBlocked && (
                <Text style={{ color: "#f59e0b", fontSize: 10, fontWeight: "500" }}>
                  {(card.blockedByIds ?? []).length} blocker
                  {(card.blockedByIds ?? []).length !== 1 ? "s" : ""}
                </Text>
              )}
              {!!card.dueDate && (() => {
                const status = getDueDateStatus(card.dueDate!);
                const color =
                  status === "overdue" ? "#ef4444" :
                  status === "today"   ? "#f59e0b" :
                  "#66635f";
                return (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                    <Calendar size={10} color={color} />
                    <Text style={{ color, fontSize: 10, fontWeight: "500" }}>
                      {status === "overdue"
                        ? `Overdue · ${formatDate(card.dueDate!)}`
                        : status === "today"
                        ? "Due today"
                        : formatDate(card.dueDate!)}
                    </Text>
                  </View>
                );
              })()}
              {linkedCount > 0 && (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 3, marginLeft: "auto" }}>
                  <FileText size={10} color="#66635f" />
                  <Text style={{ color: "#66635f", fontSize: 10 }}>{linkedCount}</Text>
                </View>
              )}
            </View>
          )}
        </View>
      </Pressable>

      {/* Move modal */}
      <Modal visible={showMove} transparent animationType="fade" statusBarTranslucent>
        <View style={StyleSheet.absoluteFillObject}>
          <View style={[StyleSheet.absoluteFillObject, { backgroundColor: "rgba(0,0,0,0.82)" }]} />
          <Pressable style={StyleSheet.absoluteFillObject} onPress={() => setShowMove(false)} />
          <View style={{ flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 32 }}>
            <View style={{
              width: "100%",
              backgroundColor: "#141414",
              borderRadius: 14,
              borderWidth: 1,
              borderColor: "#2a2a2a",
              overflow: "hidden",
            }}>
              {/* Header */}
              <View style={{
                paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12,
                borderBottomWidth: 1, borderBottomColor: "#2a2a2a",
              }}>
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

              {/* Cancel */}
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
