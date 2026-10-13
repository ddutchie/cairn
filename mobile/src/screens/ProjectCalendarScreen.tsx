import { useCallback, useState, type ReactNode } from "react";
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
  switcher,
  layout: layoutProp,
  onLayoutChange,
  todayNonce: todayNonceProp,
  onToday,
  topPad = 0,
  onOpenCard,
}: {
  nested?: boolean;
  /** Split-view column: the project to show (instead of the route param). */
  projectId?: string;
  /** Split-view column: the project-view switcher drawn above the calendar. */
  switcher?: ReactNode;
  /** Split-view column: own the span / "today" state outside (its controls live elsewhere). */
  layout?: CalendarLayout;
  onLayoutChange?: (layout: CalendarLayout) => void;
  todayNonce?: number;
  /** Split-view column: the Today button's handler when `todayNonce` is owned outside. */
  onToday?: () => void;
  /** Split-view column: breathing room above the calendar when its bar is hidden. */
  topPad?: number;
  /** Split-view column: open a task beside the calendar instead of pushing it. */
  onOpenCard?: (id: string) => void;
}) {
  const params = useLocalSearchParams<{ project: string }>();
  const project = projectId ?? params.project;
  const router = useRouter();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [cards, setCards] = useState<CalendarCard[]>([]);
  const [unscheduled, setUnscheduled] = useState<CalendarCard[]>([]);
  const [name, setName] = useState<string>("");
  const [ownLayout, setOwnLayout] = useState<CalendarLayout>("month");
  const [ownTodayNonce, setOwnTodayNonce] = useState(0);
  const layout = layoutProp ?? ownLayout;
  const setLayout = onLayoutChange ?? setOwnLayout;
  const todayNonce = todayNonceProp ?? ownTodayNonce;
  const setTodayNonce = setOwnTodayNonce;

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
    <View style={[styles.root, { backgroundColor: t.background, paddingTop: topPad }]}>
      <ScreenChrome
        title={name ? `${name} · Calendar` : "Calendar"}
        right={[
          { kind: "button", key: "today", label: "Today", icon: ICON_TODAY, onPress: toolbarPress(() => (onToday ? onToday() : setTodayNonce((n) => n + 1))) },
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
      {switcher != null && <View style={styles.switcher}>{switcher}</View>}
      <CalendarView
        cards={cards}
        bottomInset={insets.bottom}
        layout={layout}
        onLayoutChange={setLayout}
        todayNonce={todayNonce}
        unscheduled={unscheduled}
        onReschedule={reschedule}
        onOpenCard={(id) => (onOpenCard ? onOpenCard(id) : router.push(cardHref(id)))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // Same insets as ProjectScreen's segment bar, but in flow above the calendar.
  switcher: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6 },
});
