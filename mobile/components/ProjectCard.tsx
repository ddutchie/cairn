/**
 * ProjectCard — matches the desktop ProjectItem + ProjectOverview header style.
 * Surface bg, 1px border, icon + name + status badge + priority dot.
 */
import { View, Text, Pressable } from "react-native";
import { ArrowRight } from "lucide-react-native";
import type { Project } from "../../src/types/index";

const STATUS_COLOR: Record<Project["status"], string> = {
  active:    "#3ecf8e",
  on_hold:   "#f59e0b",
  completed: "#7c6af7",
  archived:  "#66635f",
};

const PRIORITY_COLOR: Record<Project["priority"], string> = {
  low:    "#666360",
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
        borderColor: pressed ? "rgba(124,106,247,0.3)" : "#2a2a2a",
        padding: 14,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
      })}
    >
      {/* Icon */}
      {project.icon ? (
        <Text style={{ fontSize: 20, lineHeight: 28, width: 28, textAlign: "center" }}>{project.icon}</Text>
      ) : (
        <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: "#222", alignItems: "center", justifyContent: "center" }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: PRIORITY_COLOR[project.priority] }} />
        </View>
      )}

      {/* Text block */}
      <View style={{ flex: 1, gap: 3 }}>
        <Text numberOfLines={1} style={{ color: "#e8e4dc", fontSize: 13, fontWeight: "500", letterSpacing: -0.1 }}>
          {project.name}
        </Text>
        {project.description ? (
          <Text numberOfLines={1} style={{ color: "#66635f", fontSize: 11, lineHeight: 15 }}>
            {project.description}
          </Text>
        ) : null}
        {/* Status badge */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 1 }}>
          <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: STATUS_COLOR[project.status] }} />
          <Text style={{ color: STATUS_COLOR[project.status], fontSize: 10, fontWeight: "500", textTransform: "capitalize" }}>
            {project.status.replace("_", " ")}
          </Text>
          <Text style={{ color: "#3a3835", fontSize: 10, marginLeft: 6 }}>
            {new Date(project.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </Text>
        </View>
      </View>

      <ArrowRight color="#3a3835" size={14} />
    </Pressable>
  );
}
