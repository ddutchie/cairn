import { useCallback, useState } from "react";
import { useLocalSearchParams, useRouter, useFocusEffect, Stack, type Href } from "expo-router";
import { View, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  getProject,
  listCardsWithDueDates,
  type CalendarCard,
} from "@/db/queries";
import { CalendarView } from "@/components/CalendarView";
import { useDataChanged } from "@/sync/useSyncStatus";
import { useTheme } from "@/theme";

/**
 * Per-project Calendar — the same month grid + agenda as the workspace tab, but
 * scoped to one project's due tasks. Reached from the project screen's toolbar.
 * The project id arrives as a `?project=` query param.
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
  const [name, setName] = useState<string>("");

  const load = useCallback(() => {
    if (!project) return;
    setCards(listCardsWithDueDates(project));
    setName(getProject(project)?.name ?? "");
  }, [project]);
  useFocusEffect(useCallback(() => load(), [load]));
  useDataChanged(load);

  const cardHref = useCallback(
    (id: string): Href =>
      nested ? { pathname: "/projects/card/[id]", params: { id } } : { pathname: "/card/[id]", params: { id } },
    [nested],
  );

  return (
    <View style={[styles.root, { backgroundColor: t.background }]}>
      <Stack.Screen options={{ title: name ? `${name} · Calendar` : "Calendar" }} />
      <CalendarView
        cards={cards}
        bottomInset={insets.bottom}
        onOpenCard={(id) => router.push(cardHref(id))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
