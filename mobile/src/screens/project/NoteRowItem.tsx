import { memo, useCallback, useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { FileText, Pin } from "lucide-react-native";
import { PressableScale } from "@/components/PressableScale";
import { TagChips } from "@/components/TagChips";
import { type as typeScale, type Theme } from "@/theme";
import { stripMarkdown } from "@cairn/shared/notes/text";
import { formatRelative } from "@cairn/shared/format/date";
import type { NoteRow, TagRow } from "@/db/queries";

/**
 * One note row in the project notes list. Mirrors the desktop NoteListItem:
 * title, a 1-line content preview, then a meta row of relative time + up to 3
 * tag chips. Tags are resolved once by the parent (tagsByRow) and passed in, so
 * this row does no DB work on render. `onOpen` / `onLongPress` are stable refs
 * → this memoised row skips re-render when unrelated parent state changes.
 */
export const NoteRowItem = memo(function NoteRowItem({
  note,
  depth,
  tags,
  onOpen,
  onLongPress,
  t,
}: {
  note: NoteRow;
  depth: number;
  tags?: TagRow[];
  onOpen: (id: string) => void;
  onLongPress: (note: NoteRow) => void;
  t: Theme;
}) {
  const preview = useMemo(() => {
    const text = stripMarkdown(note.content ?? "").trim();
    return text ? text.slice(0, 80) : "Empty note";
  }, [note.content]);
  const shownTags = useMemo(() => (tags ?? []).slice(0, 3), [tags]);
  const onPress = useCallback(() => onOpen(note.id), [onOpen, note.id]);
  const handleLongPress = useCallback(() => onLongPress(note), [onLongPress, note]);
  return (
    <PressableScale
      scaleTo={1}
      dimTo={0.5}
      onPress={onPress}
      onLongPress={handleLongPress}
      delayLongPress={350}
      style={{
        gap: 3,
        paddingVertical: 10,
        paddingRight: 14,
        paddingLeft: 14 + depth * 16,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: t.borderSubtle,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <FileText size={13} color={t.textTertiary} />
        {note.is_pinned ? <Pin size={11} color={t.accent} fill={t.accent} /> : null}
        <Text style={{ flex: 1, color: t.textPrimary, ...typeScale.control, fontWeight: "500" }} numberOfLines={1}>
          {note.title || "Untitled"}
        </Text>
      </View>
      <Text style={{ color: t.textTertiary, ...typeScale.caption, paddingLeft: 21 }} numberOfLines={1}>
        {preview}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 21 }}>
        <Text style={{ color: t.textTertiary, ...typeScale.micro, fontWeight: "400" }}>{formatRelative(note.updated_at)}</Text>
        {shownTags.length > 0 && <TagChips tags={shownTags} size="sm" />}
      </View>
    </PressableScale>
  );
});
