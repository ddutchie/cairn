import { useCallback, useState } from "react";
import { useLocalSearchParams, useRouter, Stack, type Href } from "expo-router";
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
import { ICON_VIEW_MONTH, ICON_VIEW_WEEK } from "@/components/toolbar-icons";
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
export function ProjectCalendarScreen({ nested = false }: { nested?: boolean }) {
  const { project } = useLocalSearchParams<{ project: string }>();
  const router = useRouter();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [cards, setCards] = useState<CalendarCard[]>([]);
  const [unscheduled, setUnscheduled] = useState<CalendarCard[]>([]);
  const [name, setName] = useState<string>("");
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
    },
    [load],
  );

  const cardHref = useCallback(
    (id: string): Href =>
      nested ? { pathname: "/projects/card/[id]", params: { id } } : { pathname: "/card/[id]", params: { id } },
    [nested],
  );

  return (
    <View style={[styles.root, { backgroundColor: t.background }]}>
      <Stack.Screen options={{ title: name ? `${name} · Calendar` : "Calendar" }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          accessibilityLabel="Jump to today"
          onPress={toolbarPress(() => setTodayNonce((n) => n + 1))}
        >
          Today
        </Stack.Toolbar.Button>
        <Stack.Toolbar.Menu
          icon={layout === "month" ? ICON_VIEW_MONTH : ICON_VIEW_WEEK}
          accessibilityLabel="Calendar span"
        >
          <Stack.Toolbar.Label>{layout === "month" ? "Month" : "Week"}</Stack.Toolbar.Label>
          <Stack.Toolbar.MenuAction
            icon={ICON_VIEW_MONTH}
            isOn={layout === "month"}
            onPress={toolbarPress(() => setLayout("month"))}
          >
            Month
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            icon={ICON_VIEW_WEEK}
            isOn={layout === "week"}
            onPress={toolbarPress(() => setLayout("week"))}
          >
            Week
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <CalendarView
        cards={cards}
        bottomInset={insets.bottom}
        layout={layout}
        onLayoutChange={setLayout}
        todayNonce={todayNonce}
        unscheduled={unscheduled}
        onReschedule={reschedule}
        onOpenCard={(id) => router.push(cardHref(id))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
