import { View, Text, Pressable } from "react-native";
import type { Project } from "../../src/types/index";

const STATUS_COLORS: Record<Project["status"], string> = {
  active: "#22c55e",
  on_hold: "#eab308",
  completed: "#6366f1",
  archived: "#52525b",
};

const PRIORITY_COLORS: Record<Project["priority"], string> = {
  low: "#3f3f46",
  medium: "#6366f1",
  high: "#f97316",
  urgent: "#ef4444",
};

interface Props {
  project: Project;
  onPress: () => void;
}

export function ProjectCard({ project, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      className="bg-zinc-900 rounded-2xl p-4 active:opacity-80"
    >
      {/* Top row */}
      <View className="flex-row items-start justify-between gap-3 mb-2">
        <View className="flex-row items-center gap-2 flex-1">
          {project.icon && (
            <Text className="text-xl">{project.icon}</Text>
          )}
          <Text className="text-white font-semibold text-base flex-1" numberOfLines={1}>
            {project.name}
          </Text>
        </View>
        {/* Priority dot */}
        <View
          className="w-2 h-2 rounded-full mt-1.5 shrink-0"
          style={{ backgroundColor: PRIORITY_COLORS[project.priority] }}
        />
      </View>

      {/* Description */}
      {project.description && (
        <Text className="text-zinc-500 text-sm mb-3 leading-5" numberOfLines={2}>
          {project.description}
        </Text>
      )}

      {/* Footer */}
      <View className="flex-row items-center gap-2">
        <View
          className="flex-row items-center gap-1.5 px-2 py-0.5 rounded-full"
          style={{ backgroundColor: `${STATUS_COLORS[project.status]}22` }}
        >
          <View
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: STATUS_COLORS[project.status] }}
          />
          <Text
            className="text-xs font-medium capitalize"
            style={{ color: STATUS_COLORS[project.status] }}
          >
            {project.status.replace("_", " ")}
          </Text>
        </View>

        <Text className="text-zinc-700 text-xs ml-auto">
          {new Date(project.updatedAt).toLocaleDateString()}
        </Text>
      </View>
    </Pressable>
  );
}
