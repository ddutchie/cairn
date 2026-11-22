import { useMemo } from "react";
import { View, Text, SectionList, StyleSheet } from "react-native";
import { useRouter, type Href } from "expo-router";
import { PressableScale } from "@/components/PressableScale";
import { EmptyState } from "@/components/EmptyState";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { buildZoneModel, formatDiff, type ZonePerson } from "@cairn/shared/people/zones";
import type { PersonSummary } from "@cairn/shared/types/people-view";

type Bucket = "work" | "edge" | "asleep";
const TITLES: Record<Bucket, string> = { work: "Working now", edge: "Early or late", asleep: "Asleep" };

const bucketOf = (z: ZonePerson): Bucket => (z.atWork ? "work" : z.asleep ? "asleep" : "edge");
const cityOf = (tz: string) => (tz.split("/").pop() ?? tz).replace(/_/g, " ");

/**
 * The Time zones segment of People: who is in working hours right now, who is
 * at the edges of their day and who is asleep, each with their local time and
 * how many working hours you share. People with no known zone are listed last.
 */
export function ZonesList({ people, now }: { people: readonly PersonSummary[]; now: Date }) {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();
  const model = useMemo(() => {
    const me = people.find((p) => p.isMe) ?? null;
    return buildZoneModel(people, me, now);
  }, [people, now]);
  const sections = useMemo(() => {
    const out: { key: string; title: string; data: ZonePerson[] }[] = [];
    for (const b of ["work", "edge", "asleep"] as Bucket[]) {
      const data = model.rows.filter((z) => bucketOf(z) === b);
      if (data.length) out.push({ key: b, title: `${TITLES[b]} · ${data.length}`, data });
    }
    return out;
  }, [model]);
  const tone = (b: Bucket) => (b === "work" ? t.success : b === "edge" ? t.warning : t.textTertiary);
  const open = (id: string) => router.push({ pathname: "/workspace/people/[id]", params: { id } } as Href);

  return (
    <SectionList
      sections={sections}
      keyExtractor={(z) => z.person.id}
      contentContainerStyle={s.list}
      ListHeaderComponent={
        sections.length > 0 ? <Text style={s.note}>{`Your time zone: ${cityOf(model.me.timezone)}${model.me.fromProfile ? "" : " (this phone)"}`}</Text> : undefined
      }
      ListEmptyComponent={
        <EmptyState title="No time zones yet" subtitle="Add a location or time zone to someone's page and where they are in their day shows up here." />
      }
      renderSectionHeader={({ section }) => <Text style={s.header}>{section.title}</Text>}
      renderItem={({ item }) => (
        <PressableScale
          style={s.row}
          onPress={() => open(item.person.id)}
          accessibilityRole="button"
          accessibilityLabel={`${item.person.name}, ${item.localTime} in ${cityOf(item.timezone)}, ${formatDiff(item.diffMinutes)}`}
        >
          <View style={[s.dot, { backgroundColor: tone(bucketOf(item)) }]} />
          <View style={s.body}>
            <Text style={s.name} numberOfLines={1}>{item.person.name}</Text>
            <Text style={s.meta} numberOfLines={1}>
              {[cityOf(item.timezone), formatDiff(item.diffMinutes), item.overlap > 0 ? `${item.overlap}h shared` : "no shared hours"].join(" · ")}
            </Text>
          </View>
          <Text style={s.time}>{item.localTime}</Text>
        </PressableScale>
      )}
      ListFooterComponent={
        model.unset.length > 0 ? (
          <Text style={s.foot}>{`No time zone for ${model.unset.map((p) => p.name).join(", ")}.`}</Text>
        ) : undefined
      }
    />
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    list: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 48 },
    note: { ...typeScale.caption, color: t.textTertiary, marginLeft: 4, marginTop: 4 },
    header: { ...typeScale.overline, color: t.textTertiary, marginTop: 16, marginBottom: 6, marginLeft: 4 },
    row: {
      flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14,
      borderRadius: 12, backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, marginBottom: 6,
    },
    dot: { width: 10, height: 10, borderRadius: 5 },
    body: { flex: 1, gap: 2 },
    name: { ...typeScale.control, color: t.textPrimary },
    meta: { ...typeScale.caption, color: t.textTertiary },
    time: { ...typeScale.control, color: t.textPrimary, fontVariant: ["tabular-nums"] },
    foot: { ...typeScale.caption, color: t.textTertiary, marginTop: 14, marginLeft: 4 },
  });
}
