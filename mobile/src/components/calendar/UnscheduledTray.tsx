import { useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
import { ChevronDown, Inbox } from "lucide-react-native";
import Animated from "react-native-reanimated";
import { useZoneHighlight, type DragController } from "@/dnd";
import { type Theme } from "@/theme";
import { UNSCHEDULED_DROP_ID } from "@cairn/shared/calendar/dnd";
import type { CalendarCard } from "@/db/queries";
import { DraggableChip } from "./DraggableChip";
import type { CalendarStyles } from "./styles";

/**
 * Droppable Unscheduled tray: undated tasks. Drag a chip out onto a day to
 * schedule it; drag a dated task in to clear its due date. Collapsible.
 */
export function UnscheduledTray({
  cards,
  ctrl,
  showProject,
  onOpenCard,
  t,
  styles,
}: {
  cards: CalendarCard[];
  ctrl: DragController<CalendarCard>;
  showProject: boolean;
  onOpenCard: (id: string) => void;
  t: Theme;
  styles: CalendarStyles;
}) {
  const [open, setOpen] = useState(true);
  const hoverStyle = useZoneHighlight(ctrl, UNSCHEDULED_DROP_ID);
  // In the workspace calendar (showProject) group undated tasks by project so a
  // large backlog is easy to scan; per-project calendars keep a flat list.
  const groups = useMemo(() => {
    if (!showProject) return null;
    const byProject = new Map<string, CalendarCard[]>();
    for (const c of cards) {
      const key = c.project_name || "Unknown project";
      const arr = byProject.get(key);
      if (arr) arr.push(c);
      else byProject.set(key, [c]);
    }
    return [...byProject.entries()]
      .map(([name, items]) => ({ name, items }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [cards, showProject]);

  const renderChip = (card: CalendarCard) => (
    <View key={card.id} style={styles.trayChipWrap}>
      <DraggableChip
        card={card}
        sourceZoneId={UNSCHEDULED_DROP_ID}
        ctrl={ctrl}
        dragEnabled
        onPress={() => onOpenCard(card.id)}
        t={t}
        styles={styles}
      />
    </View>
  );

  return (
    <View
      ref={(node: View | null) => ctrl.registerZone(UNSCHEDULED_DROP_ID, node)}
      collapsable={false}
      style={styles.tray}
    >
      <Animated.View pointerEvents="none" style={[styles.trayHighlight, hoverStyle]} />
      <Pressable style={styles.trayHeader} onPress={() => setOpen((o) => !o)}>
        <ChevronDown size={13} color={t.textSecondary} style={{ transform: [{ rotate: open ? "0deg" : "-90deg" }] }} />
        <Inbox size={13} color={t.textSecondary} />
        <Text style={styles.trayTitle}>Unscheduled</Text>
        <Text style={styles.trayCount}>{cards.length}</Text>
      </Pressable>
      {open ? (
        cards.length === 0 ? (
          <Text style={styles.trayEmpty}>No unscheduled tasks. Drag a task here to clear its due date.</Text>
        ) : (
          <ScrollView
            style={styles.trayScroll}
            nestedScrollEnabled
            showsVerticalScrollIndicator
            // While a chip is lifted the outer grid scroll is locked; keep the
            // tray's own scroll locked too so the drag gesture isn't stolen.
            scrollEnabled={!ctrl.scrollLocked}
          >
            {groups ? (
              groups.map((g) => (
                <View key={g.name} style={styles.trayGroup}>
                  <Text style={styles.trayGroupLabel} numberOfLines={1}>
                    {g.name} <Text style={styles.trayGroupCount}>{g.items.length}</Text>
                  </Text>
                  <View style={styles.trayChips}>{g.items.map(renderChip)}</View>
                </View>
              ))
            ) : (
              <View style={styles.trayChips}>{cards.map(renderChip)}</View>
            )}
          </ScrollView>
        )
      ) : null}
    </View>
  );
}
