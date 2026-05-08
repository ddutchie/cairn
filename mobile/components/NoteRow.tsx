import { View, Text, Pressable } from "react-native";
import { formatDistanceToNow } from "date-fns";
import { Pin, LayoutDashboard } from "lucide-react-native";
import type { Note } from "../../src/types/index";

export function NoteRow({ note, onPress }: { note: Note; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "stretch",
        paddingVertical: 10,
        paddingRight: 12,
        backgroundColor: pressed ? "#1a1a1a" : "transparent",
        borderBottomWidth: 1,
        borderBottomColor: "#1f1f1f",
      })}
    >
      {/* Left accent bar for pinned notes */}
      <View
        style={{
          width: 2,
          borderRadius: 1,
          backgroundColor: note.isPinned ? "#7c6af7" : "transparent",
          marginRight: 10,
          marginLeft: 0,
          alignSelf: "stretch",
        }}
      />

      {/* Content */}
      <View style={{ flex: 1 }}>
        {/* Title row */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 2 }}>
          {note.isPinned && <Pin size={9} color="#7c6af7" />}
          {note.type === "dashboard" && <LayoutDashboard size={9} color="#66635f" />}
          <Text
            numberOfLines={1}
            style={{ flex: 1, color: "#9e9a94", fontSize: 12, fontWeight: "500" }}
          >
            {note.title}
          </Text>
        </View>

        {/* Snippet */}
        <Text
          numberOfLines={1}
          style={{ color: "#66635f", fontSize: 11, marginBottom: 2 }}
        >
          {note.contentText?.slice(0, 80) || "Empty note"}
        </Text>

        {/* Timestamp */}
        <Text style={{ color: "#3a3835", fontSize: 10 }}>
          {formatDistanceToNow(new Date(note.updatedAt), { addSuffix: true })}
        </Text>
      </View>
    </Pressable>
  );
}
