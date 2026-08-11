import { View, Text } from "react-native";
import { PressableScale } from "@/components/PressableScale";
import { withAlpha, PRIORITY_COLOR, type Theme } from "@/theme";
import { getDueDateStatus } from "@cairn/shared/format/date";
import type { CalendarCard, TagRow } from "@/db/queries";
import type { CalendarStyles } from "./styles";

/**
 * A row in the selected-day list below the grid: priority bar, title, project
 * (in the workspace calendar), a "Today" badge, and up to three tag chips.
 */
export function DayDetailRow({
  card,
  tags,
  showProject,
  onPress,
  t,
  styles,
}: {
  card: CalendarCard;
  tags?: TagRow[];
  showProject: boolean;
  onPress: () => void;
  t: Theme;
  styles: CalendarStyles;
}) {
  const allTags = tags ?? [];
  const shownTags = allTags.slice(0, 3);
  const overflow = Math.max(0, allTags.length - shownTags.length);
  const status = getDueDateStatus(card.due_date);
  const priorityColor = PRIORITY_COLOR[card.priority] ?? t.textTertiary;
  return (
    <PressableScale scaleTo={1} dimTo={0.5} onPress={onPress} style={styles.sheetRow}>
      <View style={[styles.priorityBar, { backgroundColor: priorityColor }]} />
      <View style={styles.sheetRowBody}>
        <Text style={styles.sheetRowTitle} numberOfLines={2}>
          {card.title}
        </Text>
        <View style={styles.sheetRowMeta}>
          {showProject ? (
            <Text style={styles.sheetRowProject} numberOfLines={1}>
              {card.project_name}
            </Text>
          ) : null}
          {status === "today" ? (
            <Text style={[styles.sheetBadge, { color: t.warning }]}>Today</Text>
          ) : null}
          {shownTags.map((tag) => (
            <View
              key={tag.id}
              style={[
                styles.tagChip,
                { backgroundColor: withAlpha(tag.color, 0.14), borderColor: withAlpha(tag.color, 0.35) },
              ]}
            >
              <View style={[styles.tagDot, { backgroundColor: tag.color }]} />
              <Text style={[styles.tagText, { color: t.textSecondary }]} numberOfLines={1}>
                {tag.name}
              </Text>
            </View>
          ))}
          {overflow > 0 && (
            <View style={[styles.tagChip, { backgroundColor: "transparent", borderColor: t.border }]}>
              <Text style={[styles.tagText, { color: t.textTertiary }]}>+{overflow}</Text>
            </View>
          )}
        </View>
      </View>
    </PressableScale>
  );
}
