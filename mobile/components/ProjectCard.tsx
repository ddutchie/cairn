import { View, Text, Pressable } from "react-native";
import type { Project } from "../../src/types/index";

const STATUS_COLOR: Record<Project["status"], string> = {
  active:    "#3ecf8e",
  on_hold:   "#f59e0b",
  completed: "#7c6af7",
  archived:  "#66635f",
};

const PRIORITY_COLOR: Record<Project["priority"], string> = {
  low:    "#66635f",
  medium: "#7c6af7",
  high:   "#f97316",
  urgent: "#ef4444",
};

export function ProjectCard({ project, onPress }: { project: Project; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? "#1a1a1a" : "#141414",
        borderRadius: 12,
        borderWidth: 1,
        borderColor: "#2a2a2a",
        padding: 16,
      })}
    >
      {/* Top row */}
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
        {project.icon && (
          <Text style={{ fontSize: 18, lineHeight: 24 }}>{project.icon}</Text>
        )}
        <Text
          numberOfLines={1}
          style={{ flex: 1, color: "#e8e4dc", fontSize: 15, fontWeight: "600", letterSpacing: -0.2 }}
        >
          {project.name}
        </Text>
        {/* Priority indicator */}
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: PRIORITY_COLOR[project.priority], marginTop: 4, flexShrink: 0 }} />
      </View>

      {project.description && (
        <Text
          numberOfLines={2}
          style={{ color: "#9e9a94", fontSize: 12, lineHeight: 17, marginBottom: 12 }}
        >
          {project.description}
        </Text>
      )}

      {/* Footer */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, backgroundColor: `${STATUS_COLOR[project.status]}18` }}>
          <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: STATUS_COLOR[project.status] }} />
          <Text style={{ color: STATUS_COLOR[project.status], fontSize: 11, fontWeight: "500", textTransform: "capitalize" }}>
            {project.status.replace("_", " ")}
          </Text>
        </View>
        <Text style={{ color: "#3a3835", fontSize: 11, marginLeft: "auto" }}>
          {new Date(project.updatedAt).toLocaleDateString()}
        </Text>
      </View>
    </Pressable>
  );
}
