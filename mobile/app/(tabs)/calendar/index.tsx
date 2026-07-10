import { useCallback, useState } from "react";
import { Stack, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { listCardsWithDueDates, type CalendarCard } from "@/db/queries";
import { CalendarView, type CalendarLayout } from "@/components/CalendarView";
import { TabScreen } from "@/components/TabScreen";
import { ICON_VIEW_MONTH, ICON_VIEW_WEEK } from "@/components/toolbar-icons";
import { toolbarPress } from "@/haptics";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";

/**
 * Workspace-wide Calendar: every live task with a due date across all projects,
 * on a month grid with a per-day agenda. Project names are shown on each row so
 * cross-project due dates are distinguishable.
 *
 * The primary controls — "Today" and the Month/Week switch — live in the native
 * Stack.Toolbar (right) so the tab reads like the rest of the app; the grid's
 * in-body toolbar keeps only prev/next + the period label. This screen owns the
 * `layout` state and a `todayNonce` it bumps to jump the grid back to today.
 */
export default function CalendarScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [cards, setCards] = useState<CalendarCard[]>([]);
  const [layout, setLayout] = useState<CalendarLayout>("month");
  const [todayNonce, setTodayNonce] = useState(0);

  const load = useCallback(() => setCards(listCardsWithDueDates()), []);
  useRefreshOnFocus(load);

  return (
    <TabScreen>
      <Stack.Screen options={{ title: "Calendar" }} />
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
        showProject
        bottomInset={insets.bottom}
        layout={layout}
        onLayoutChange={setLayout}
        todayNonce={todayNonce}
        onOpenCard={(id) => router.push({ pathname: "/card/[id]", params: { id, back: "Calendar" } })}
      />
    </TabScreen>
  );
}
