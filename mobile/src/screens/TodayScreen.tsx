import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useRouter, type Href } from "expo-router";
import { EmptyState } from "@/components/EmptyState";
import { PressableScale } from "@/components/PressableScale";
import { TabScreen } from "@/components/TabScreen";
import { loadLocalToday } from "@/lib/local-today";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { freeTimeLine, localTodayLine, type LocalToday } from "@cairn/shared/today/local";
import { formatMinutes } from "@cairn/shared/today/brief";
import { setActionItemDone } from "@/db/people";
import { haptics } from "@/haptics";
import { formatDate } from "@cairn/shared/format/date";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/** Minutes since midnight as a clock time in the user's locale. */
const clock = (min: number) => {
  const d = new Date();
  d.setHours(Math.floor(min / 60), min % 60, 0, 0);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

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
  // Reload when the local day rolls over while the screen stays open, and when the app comes back to the
  // foreground (a timer does not fire while suspended).
  useEffect(() => {
    const next = new Date();
    next.setHours(24, 0, 0, 0);
    const timer = setTimeout(load, next.getTime() - Date.now() + 1000);
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") load(); });
    return () => { clearTimeout(timer); sub.remove(); };
  }, [load, today?.date]);

  const task = (id: string) => router.push({ pathname: "/card/[id]", params: { id } } as Href);
  const note = (id: string) => router.push({ pathname: "/note/[id]", params: { id } } as Href);
  const tick = (i: LocalToday["youOwe"][number]) => {
    haptics.selection();
    // A false result means the note changed since it was listed; reloading shows the current list.
    setActionItemDone(i.noteId, i.lineKey, true, i.bodyDigest);
    load();
  };
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

  const empty = today && !today.overdue.length && !today.dueToday.length && !today.meetings.length && !today.youOwe.length && !today.peopleDue.length;
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
            {today.meetings.length ? (
              <View>
                <Text style={s.section}>{`Your day · ${today.meetings.length}`}</Text>
                {freeTimeLine(today.day) ? <Text style={s.freeLine}>{freeTimeLine(today.day)}</Text> : null}
                {today.day.blocks.map((b) =>
                  b.kind === "meeting" ? (
                    row(`m-${b.event?.id}-${b.start}`, b.event?.title ?? "Meeting", `${clock(b.start)} to ${clock(b.end)}`, undefined, b.past ? t.textTertiary : t.accent)
                  ) : b.past ? null : (
                    <View key={`f-${b.start}`} style={[s.free, b.best && { borderColor: t.accent }]} accessibilityLabel={`Free ${clock(b.start)} to ${clock(b.end)}`}>
                      <Text style={s.freeText}>{`Free · ${formatMinutes(b.end - b.start)}`}</Text>
                      <Text style={s.freeText}>{`${clock(b.start)} to ${clock(b.end)}${b.best ? " · longest" : ""}`}</Text>
                    </View>
                  ),
                )}
              </View>
            ) : null}
            {section("You owe", today.youOwe.length, today.youOwe.map((i) => (
              <View key={`${i.noteId}-${i.lineKey}`} style={s.owedRow}>
                <PressableScale style={s.tickBtn} onPress={() => tick(i)} accessibilityRole="checkbox" accessibilityState={{ checked: false }} accessibilityLabel={`Mark done: ${i.text}`}>
                  <View style={s.tickBox} />
                </PressableScale>
                <PressableScale style={s.owedBody} onPress={() => note(i.noteId)} accessibilityLabel={`${i.text}, in ${i.noteTitle}`}>
                  <Text style={s.title} numberOfLines={2}>{i.text}</Text>
                  <Text style={s.line} numberOfLines={1}>{i.noteTitle}</Text>
                </PressableScale>
              </View>
            )))}
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
    freeLine: { ...typeScale.caption, color: t.textSecondary, marginHorizontal: 4, marginBottom: 8 },
    free: {
      flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, paddingHorizontal: 14, borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth, borderStyle: "dashed", borderColor: t.border, marginBottom: 6,
    },
    freeText: { ...typeScale.caption, color: t.textTertiary },
    owedRow: {
      flexDirection: "row", alignItems: "center", borderRadius: 12, backgroundColor: t.surface,
      borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, marginBottom: 6,
    },
    tickBtn: { paddingVertical: 12, paddingLeft: 14, paddingRight: 8 },
    tickBox: { width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, borderColor: t.textTertiary },
    owedBody: { flex: 1, gap: 2, paddingVertical: 12, paddingRight: 14 },
    dot: { width: 8, height: 8, borderRadius: 999 },
    body: { flex: 1, gap: 2 },
    title: { ...typeScale.control, color: t.textPrimary },
    line: { ...typeScale.caption, color: t.textTertiary },
    chevron: { ...typeScale.title, color: t.textTertiary },
  });
}
