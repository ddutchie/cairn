import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useRouter, type Href } from "expo-router";
import { EmptyState } from "@/components/EmptyState";
import { PressableScale } from "@/components/PressableScale";
import { TabScreen } from "@/components/TabScreen";
import { loadLocalToday } from "@/lib/local-today";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { localTodayLine, type LocalToday } from "@cairn/shared/today/local";
import { formatDate } from "@cairn/shared/format/date";
import { useTheme, type as typeScale, type Theme } from "@/theme";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * Today, on the phone: what needs you from the data that syncs (due and overdue
 * tasks, today's meetings, people you are due to meet). The desktop's AI brief is
 * a file that does not sync, so this is the phone's own, not a copy of it.
 */
export function TodayScreen() {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();
  const [today, setToday] = useState<LocalToday | null>(null);
  const load = useCallback(() => setToday(loadLocalToday()), []);
  useRefreshOnFocus(load);

  const task = (id: string) => router.push({ pathname: "/card/[id]", params: { id } } as Href);
  const person = (id: string) => router.push({ pathname: "/workspace/people/[id]", params: { id } } as Href);

  const row = (key: string, title: string, line: string | undefined, onPress?: () => void, tone?: string): ReactNode => (
    <PressableScale key={key} style={s.row} onPress={onPress} disabled={!onPress} accessibilityLabel={line ? `${title}, ${line}` : title}>
      {tone ? <View style={[s.dot, { backgroundColor: tone }]} /> : null}
      <View style={s.body}>
        <Text style={s.title} numberOfLines={2}>{title}</Text>
        {line ? <Text style={s.line} numberOfLines={1}>{line}</Text> : null}
      </View>
      {onPress ? <Text style={s.chevron}>›</Text> : null}
    </PressableScale>
  );
  const section = (title: string, n: number, children: ReactNode) =>
    n === 0 ? null : (
      <View>
        <Text style={s.section}>{`${title} · ${n}`}</Text>
        {children}
      </View>
    );

  const empty = today && !today.overdue.length && !today.dueToday.length && !today.meetings.length && !today.peopleDue.length;
  return (
    <TabScreen>
      <Stack.Screen options={{ title: "Today" }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={s.list}>
        {today ? (
          <>
            <Text style={s.headline}>{localTodayLine(today)}</Text>
            {empty ? <EmptyState title="Nothing needs you today" subtitle="Due tasks, meetings and people to catch up with show up here." /> : null}
            {section("Overdue", today.overdue.length, today.overdue.map((x) => row(x.id, x.title, [x.projectName, `due ${formatDate(x.dueDate)}`].filter(Boolean).join(" · "), () => task(x.id), t.danger)))}
            {section("Due today", today.dueToday.length, today.dueToday.map((x) => row(x.id, x.title, x.projectName, () => task(x.id), t.warning)))}
            {section("Meetings", today.meetings.length, today.meetings.map((m) => row(m.id, m.title, m.endsAt ? `${time(m.startsAt)} to ${time(m.endsAt)}` : time(m.startsAt))))}
            {section("Catch up with", today.peopleDue.length, today.peopleDue.map((p) => row(p.id, p.name, `${p.daysOver}d past your cadence`, () => person(p.id), t.warning)))}
          </>
        ) : null}
      </ScrollView>
    </TabScreen>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    list: { padding: 12, paddingBottom: 120 },
    headline: { ...typeScale.title, color: t.textPrimary, marginHorizontal: 4, marginBottom: 6 },
    section: { ...typeScale.label, color: t.textTertiary, marginTop: 14, marginBottom: 8, marginLeft: 4 },
    row: {
      flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14,
      borderRadius: 12, backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, marginBottom: 6,
    },
    dot: { width: 8, height: 8, borderRadius: 999 },
    body: { flex: 1, gap: 2 },
    title: { ...typeScale.control, color: t.textPrimary },
    line: { ...typeScale.caption, color: t.textTertiary },
    chevron: { fontSize: 20, color: t.textTertiary },
  });
}
