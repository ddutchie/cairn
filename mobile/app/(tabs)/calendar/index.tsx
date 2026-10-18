import { useCallback, useState } from "react";
import { Stack, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { listCardsWithDueDates, listUnscheduledCards, updateTask, type CalendarCard } from "@/db/queries";
import { CalendarView, type CalendarLayout } from "@/components/CalendarView";
import { TabScreen } from "@/components/TabScreen";
import { ICON_TODAY, ICON_VIEW_MONTH, ICON_VIEW_WEEK } from "@/components/toolbar-icons";
import { toolbarPress } from "@/haptics";
import { useTheme } from "@/theme";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { SidePreviewLayout, useSidePreview } from "@/components/SidePreview";
import { railToolbar, useTightSideRail } from "@/components/screen-chrome";

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
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const tightRail = useTightSideRail();
  // Wide windows open a picked task beside the calendar (shared with Chat/Graph).
  // No title beside the grid when wide (like Chat) — the Today + span controls
  // dock into the side rail instead.
  const sp = useSidePreview({ title: "Calendar", titleWhenWide: false });
  const [cards, setCards] = useState<CalendarCard[]>([]);
  const [unscheduled, setUnscheduled] = useState<CalendarCard[]>([]);
  const [layout, setLayout] = useState<CalendarLayout>("month");
  const [todayNonce, setTodayNonce] = useState(0);

  const load = useCallback(() => {
    setCards(listCardsWithDueDates());
    setUnscheduled(listUnscheduledCards());
  }, []);
  useRefreshOnFocus(load);

  const reschedule = useCallback(
    (cardId: string, dueDate: string | null) => {
      updateTask(cardId, { dueDate });
      load();
    },
    [load],
  );

  return (
    <TabScreen>
      <Stack.Screen options={sp.screenOptions} />
      {sp.showToolbar ? (
      <Stack.Toolbar placement="right">
        {railToolbar(
          tightRail,
          <Stack.Toolbar.Button
            key="today"
            // A symbol whenever a side rail is present or wide (a text-only
            // item would stay horizontal). Narrow without a rail keeps the text label.
            icon={sp.wide || insets.left > 0 || insets.right > 0 ? ICON_TODAY : undefined}
            accessibilityLabel="Jump to today"
            onPress={toolbarPress(() => setTodayNonce((n) => n + 1))}
          >
            Today
          </Stack.Toolbar.Button>,
          <Stack.Toolbar.Menu
            key="span"
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
          </Stack.Toolbar.Menu>,
        )}
      </Stack.Toolbar>
      ) : null}
      <SidePreviewLayout state={sp} onChanged={load} bodyStyle={{ backgroundColor: t.surface }}>
      <CalendarView
        cards={cards}
        showProject
        bottomInset={insets.bottom}
        layout={layout}
        onLayoutChange={setLayout}
        todayNonce={todayNonce}
        unscheduled={unscheduled}
        onReschedule={reschedule}
        onOpenCard={(id) =>
          sp.open ? sp.open({ kind: "card", id }) : router.push({ pathname: "/card/[id]", params: { id, back: "Calendar" } })
        }
      />
      </SidePreviewLayout>
    </TabScreen>
  );
}
