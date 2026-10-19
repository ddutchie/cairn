import { useCallback, useState } from "react";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { ScreenChrome } from "@/components/screen-chrome";
import { View, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  getProject,
  listCardsWithDueDates,
  listUnscheduledCards,
  updateTask,
  type CalendarCard,
} from "@/db/queries";
import { CalendarView, type CalendarLayout } from "@/components/CalendarView";
import { ICON_TODAY, ICON_VIEW_MONTH, ICON_VIEW_WEEK } from "@/components/toolbar-icons";
import { toolbarPress } from "@/haptics";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { useTheme } from "@/theme";

/**
 * Per-project Calendar — the same month grid + agenda as the workspace tab, but
 * scoped to one project's due tasks. Reached from the project screen's toolbar.
 * The project id arrives as a `?project=` query param.
 *
 * The Today + Month/Week controls live in the native header toolbar (matching
 * the Calendar tab) rather than the in-body toolbar, so the calendar reads the
 * same however it's reached. This screen owns `layout` + a `todayNonce`.
 *
 * Shared by two routes: the root `app/project/calendar` and the Projects-tab
 * `app/(tabs)/projects/project/calendar` (`nested`). `nested` only routes the
 * onward "open card" push to the in-tab card detail so the tab bar stays
 * visible through the whole Projects drill-down.
 */
export function ProjectCalendarScreen({
  nested = false,
  projectId,
  hasSwitcher,
  selectedKey,
  onSelectKey,
  externalDayList,
  onChanged,
  onOpenCard,
}: {
  nested?: boolean;
  /** Split-view column: the project to show (instead of the route param). */
  projectId?: string;
  /** Split-view column: its project-view switcher floats over the top; reserve its height. */
  hasSwitcher?: boolean;
  /** Split-view column: the selected day lives outside (shared with the day panel beside). */
  selectedKey?: string;
  onSelectKey?: (key: string) => void;
  /** Split-view column: the day's task list is in the detail column, not under the grid. */
  externalDayList?: boolean;
  /** Split-view column: a task was rescheduled here (so the day panel can refresh). */
  onChanged?: () => void;
  /** Split-view column: open a task beside the calendar instead of pushing it. */
  onOpenCard?: (id: string) => void;
}) {
  const params = useLocalSearchParams<{ project: string }>();
  const project = projectId ?? params.project;
  const router = useRouter();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  // Seeded synchronously (cheap local reads) so the first frame already has the title and
  // the grid's tasks instead of settling a beat after mount.
  const [cards, setCards] = useState<CalendarCard[]>(() => (project ? listCardsWithDueDates(project) : []));
  const [unscheduled, setUnscheduled] = useState<CalendarCard[]>(() => (project ? listUnscheduledCards(project) : []));
  const [name, setName] = useState<string>(() => (project ? (getProject(project)?.name ?? "") : ""));
  const [layout, setLayout] = useState<CalendarLayout>("month");
  const [todayNonce, setTodayNonce] = useState(0);

  const load = useCallback(() => {
    if (!project) return;
    setCards(listCardsWithDueDates(project));
    setUnscheduled(listUnscheduledCards(project));
    setName(getProject(project)?.name ?? "");
  }, [project]);
  useRefreshOnFocus(load);

  const reschedule = useCallback(
    (cardId: string, dueDate: string | null) => {
      updateTask(cardId, { dueDate });
      load();
      onChanged?.();
    },
    [load, onChanged],
  );

  const cardHref = useCallback(
    (id: string): Href =>
      nested ? { pathname: "/projects/card/[id]", params: { id } } : { pathname: "/card/[id]", params: { id } },
    [nested],
  );

  return (
    <View style={[styles.root, hasSwitcher && styles.underSwitcher, { backgroundColor: t.background }]}>
      <ScreenChrome
        // In the split view the view switcher already says "Calendar"; the standalone route has none.
        title={hasSwitcher ? name || "Calendar" : name ? `${name} · Calendar` : "Calendar"}
        right={[
          { kind: "button", key: "today", label: "Today", icon: ICON_TODAY, onPress: toolbarPress(() => setTodayNonce((n) => n + 1)) },
          {
            kind: "menu",
            key: "span",
            label: "Calendar span",
            icon: layout === "month" ? ICON_VIEW_MONTH : ICON_VIEW_WEEK,
            // No visible text: text-labelled items can't dock into the Duo's
            // side rail (Apple) — the icon already shows the current span.
            actions: [
              { label: "Month", icon: ICON_VIEW_MONTH, isOn: layout === "month", onPress: toolbarPress(() => setLayout("month")) },
              { label: "Week", icon: ICON_VIEW_WEEK, isOn: layout === "week", onPress: toolbarPress(() => setLayout("week")) },
            ],
          },
        ]}
      />
      <CalendarView
        cards={cards}
        bottomInset={insets.bottom}
        layout={layout}
        onLayoutChange={setLayout}
        todayNonce={todayNonce}
        unscheduled={unscheduled}
        onReschedule={reschedule}
        selectedKey={selectedKey}
        onSelectKey={onSelectKey}
        externalDayList={externalDayList}
        onOpenCard={(id) => (onOpenCard ? onOpenCard(id) : router.push(cardHref(id)))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // Clears the column's floating switcher bar (8 + 36 + 6, same as ProjectScreen's SEGMENT_BAR_H).
  underSwitcher: { paddingTop: 50 },
});
