import { memo, useCallback } from "react";
import { Text, Pressable } from "react-native";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react-native";
import { type as typeScale, type Theme } from "@/theme";
import type { NoteRow } from "@/db/queries";
import type { FolderNode } from "@cairn/shared/notes/folder-tree";

/**
 * A single folder header row. Non-recursive: the tree is flattened by the parent
 * so each folder + its (visible) descendants are separate FlatList rows. Toggling
 * only flips `collapsed[path]`, which re-derives the flattened row list.
 */
export const FolderRow = memo(function FolderRow({
  node,
  depth,
  collapsed,
  onToggle,
  t,
}: {
  node: FolderNode<NoteRow>;
  depth: number;
  collapsed: boolean;
  onToggle: (p: string) => void;
  t: Theme;
}) {
  const onPress = useCallback(() => onToggle(node.path), [onToggle, node.path]);
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingVertical: 9,
        paddingRight: 14,
        paddingLeft: 12 + depth * 16,
        backgroundColor: t.surface2,
      }}
    >
      {collapsed ? <ChevronRight size={14} color={t.textTertiary} /> : <ChevronDown size={14} color={t.textTertiary} />}
      {collapsed ? <Folder size={14} color={t.accent} /> : <FolderOpen size={14} color={t.accent} />}
      <Text style={{ flex: 1, color: t.textSecondary, ...typeScale.label }} numberOfLines={1}>
        {node.name}
      </Text>
      <Text style={{ color: t.textTertiary, ...typeScale.micro, fontWeight: "400" }}>{node.notes.length}</Text>
    </Pressable>
  );
});
