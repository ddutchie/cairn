import { View, Text, Pressable } from "react-native";
import { formatDistanceToNow } from "date-fns";
import type { Note } from "../../src/types/index";

export function NoteRow({ note, onPress }: { note: Note; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        paddingVertical: 12,
        paddingHorizontal: 4,
        borderBottomWidth: 1,
        borderBottomColor: "#1f1f1f",
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        {note.isPinned && (
          <View style={{ width: 3, alignSelf: "stretch", borderRadius: 2, backgroundColor: "#7c6af7", marginTop: 2, marginBottom: 2 }} />
        )}
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ color: "#e8e4dc", fontSize: 13, fontWeight: "500", marginBottom: 3 }}>
            {note.title}
          </Text>
          {note.contentText.trim() !== "" && (
            <Text numberOfLines={2} style={{ color: "#66635f", fontSize: 12, lineHeight: 17 }}>
              {note.contentText.slice(0, 120)}
            </Text>
          )}
        </View>
        <Text style={{ color: "#3a3835", fontSize: 11, flexShrink: 0, marginTop: 1 }}>
          {formatDistanceToNow(new Date(note.updatedAt), { addSuffix: true })}
        </Text>
      </View>
    </Pressable>
  );
}
