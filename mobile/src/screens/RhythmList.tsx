import { useMemo } from "react";
import { View, Text, SectionList, StyleSheet } from "react-native";
import { useRouter, type Href } from "expo-router";
import { PressableScale } from "@/components/PressableScale";
import { EmptyState } from "@/components/EmptyState";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { buildRhythm, type RhythmRow, type RhythmState } from "@cairn/shared/people/rhythm";
import type { PersonSummary } from "@cairn/shared/types/people-view";

const TITLES: Record<RhythmState, string> = { overdue: "Overdue", never: "Not met yet", soon: "Due soon", ok: "On track" };
const ORDER: RhythmState[] = ["overdue", "never", "soon", "ok"];

/** Plain words for one row: how long since you met, against the cadence you set. */
function describe(r: RhythmRow): string {
  const cadence = r.person.cadence ?? "";
  if (r.sinceDays === null) return `${cadence}, no meeting on record`;
  const since = r.sinceDays === 0 ? "met today" : `met ${r.sinceDays}d ago`;
  const booked = r.bookedInDays !== null ? `next in ${r.bookedInDays}d` : "";
  const over = r.state === "overdue" ? `${r.daysOver}d over` : "";
  return [cadence, since, over, booked].filter(Boolean).join(" · ");
}

/**
 * The Rhythm segment of People: who you are due to meet, by the cadence you
 * set on their page. A list, not the desktop's chart: overdue first, then due
 * soon, then on track, then people with no cadence yet. Reflects your intent,
 * nothing about anyone's activity.
 */
export function RhythmList({ people, now }: { people: readonly PersonSummary[]; now: Date }) {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();
  const model = useMemo(() => buildRhythm(people, now), [people, now]);
  const sections = useMemo(() => {
    const out: { key: string; title: string; data: RhythmRow[] }[] = [];
    for (const st of ORDER) {
      const data = model.rows.filter((r) => r.state === st);
      if (data.length) out.push({ key: st, title: `${TITLES[st]} · ${data.length}`, data });
    }
    return out;
  }, [model]);
  const tone = (st: RhythmState) => (st === "overdue" ? t.danger : st === "soon" || st === "never" ? t.warning : t.success);
  const open = (id: string) => router.push({ pathname: "/workspace/people/[id]", params: { id } } as Href);

  return (
    <SectionList
      sections={sections}
      keyExtractor={(r) => r.person.id}
      contentContainerStyle={s.list}
      ListEmptyComponent={
        <EmptyState
          title="No rhythm yet"
          subtitle="Set how often you meet someone (weekly, every two weeks or monthly) on their page and they show up here."
        />
      }
      renderSectionHeader={({ section }) => <Text style={s.header}>{section.title}</Text>}
      renderItem={({ item }) => (
        <PressableScale style={s.row} onPress={() => open(item.person.id)} accessibilityLabel={`${item.person.name}, ${describe(item)}`}>
          <View style={[s.dot, { backgroundColor: tone(item.state) }]} />
          <View style={s.body}>
            <Text style={s.name} numberOfLines={1}>{item.person.name}</Text>
            <Text style={s.meta} numberOfLines={1}>{describe(item)}</Text>
          </View>
          <Text style={s.chevron}>›</Text>
        </PressableScale>
      )}
      ListFooterComponent={
        model.noCadence.length > 0 ? (
          <Text style={s.foot}>{`${model.noCadence.length} ${model.noCadence.length === 1 ? "person has" : "people have"} no cadence set.`}</Text>
        ) : undefined
      }
    />
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    list: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 48 },
    header: { ...typeScale.overline, color: t.textTertiary, marginTop: 16, marginBottom: 6, marginLeft: 4 },
    row: {
      flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14,
      borderRadius: 12, backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, marginBottom: 6,
    },
    dot: { width: 10, height: 10, borderRadius: 5 },
    body: { flex: 1, gap: 2 },
    name: { ...typeScale.control, color: t.textPrimary },
    meta: { ...typeScale.caption, color: t.textTertiary },
    chevron: { ...typeScale.title, fontWeight: "400", color: t.textTertiary },
    foot: { ...typeScale.caption, color: t.textTertiary, marginTop: 14, marginLeft: 4 },
  });
}
