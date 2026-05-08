import { View, Text, Pressable } from "react-native";
import { Pin } from "lucide-react-native";
import { formatDistanceToNow } from "date-fns";
import type { Note } from "../../src/types/index";

interface Props {
  note: Note;
  onPress: () => void;
}

export function NoteRow({ note, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      className="py-3 border-b border-zinc-800/50 active:opacity-70"
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <View className="flex-row items-center gap-1.5 mb-1">
            {note.isPinned && <Pin color="#6366f1" size={12} />}
            <Text className="text-white font-medium text-sm" numberOfLines={1}>
              {note.title}
            </Text>
          </View>
          {note.contentText.trim() !== "" && (
            <Text className="text-zinc-500 text-xs leading-4" numberOfLines={2}>
              {note.contentText.slice(0, 120)}
            </Text>
          )}
        </View>
        <Text className="text-zinc-700 text-xs shrink-0 mt-0.5">
          {formatDistanceToNow(new Date(note.updatedAt), { addSuffix: true })}
        </Text>
      </View>
    </Pressable>
  );
}
