import { useMemo } from "react";
import { View, Text, SectionList, StyleSheet } from "react-native";
import { useRouter, type Href } from "expo-router";
import { PressableScale } from "@/components/PressableScale";
import { EmptyState } from "@/components/EmptyState";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { WORK_END, WORK_START, buildZoneModel, formatDiff, groupZoneRows, type ZoneGrouping, type ZonePerson } from "@cairn/shared/people/zones";
import type { PersonSummary } from "@cairn/shared/types/people-view";

type Bucket = "work" | "edge" | "asleep";

const bucketOf = (z: ZonePerson): Bucket => (z.atWork ? "work" : z.asleep ? "asleep" : "edge");
const AXIS = [0, 6, 12, 18, 24];
const pct = (h: number) => `${(h / 24) * 100}%` as const;
const cityOf = (tz: string) => (tz.split("/").pop() ?? tz).replace(/_/g, " ");

interface Section { key: string; title: string; note?: string; isMe?: boolean; data: ZonePerson[] }

/**
 * The Time zones segment of People: you first (tinted), then everyone else arranged by `grouping`
 * (closest by default; the toolbar menu changes it, and "Available now" hides who is asleep). Each row has
 * their local time, how many working hours you share and a 24-hour strip in your own local hours, as on the
 * computer: when they work (bright where it overlaps your 9 to 5, grey where it doesn't) with a line for now.
 * People with no known zone are listed last.
 */
export function ZonesList({ people, now, grouping, availableOnly }: {
  people: readonly PersonSummary[]; now: Date; grouping: ZoneGrouping; availableOnly: boolean;
}) {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();
  const model = useMemo(() => {
    const me = people.find((p) => p.isMe) ?? null;
    return buildZoneModel(people, me, now);
  }, [people, now]);
  const sections = useMemo(() => {
    const out: Section[] = [];
    if (model.meRow) out.push({ key: "me", title: "You", isMe: true, data: [model.meRow] });
    for (const g of groupZoneRows(model.rows, grouping, { availableOnly })) {
      out.push({ key: g.key, title: `${g.label} · ${g.rows.length}`, note: g.note, data: g.rows });
    }
    return out;
  }, [model, grouping, availableOnly]);
  const tone = (b: Bucket) => (b === "work" ? t.success : b === "edge" ? t.warning : t.textTertiary);
  const open = (id: string) => router.push({ pathname: "/workspace/people/[id]", params: { id } } as Href);

  return (
    <SectionList
      sections={sections}
      keyExtractor={(z) => z.person.id}
      contentContainerStyle={s.list}
      ListEmptyComponent={
        <EmptyState title="No time zones yet" subtitle="Add a location or time zone to someone's page and where they are in their day shows up here." />
      }
      renderSectionHeader={({ section }) => (
        <View>
          <Text style={s.header}>
            {section.title}
            {section.note ? <Text style={s.headerNote}>{`  ${section.note}`}</Text> : null}
          </Text>
          {section.key === sections[0]?.key ? (
            <View style={s.axis} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              {AXIS.map((h) => (
                <Text key={h} style={[s.tick, { left: pct(h) }, h === 24 ? s.tickEnd : h === 0 ? s.tickStart : null]}>{String(h % 24).padStart(2, "0")}</Text>
              ))}
            </View>
          ) : null}
        </View>
      )}
      renderItem={({ item }) => (
        <PressableScale
          style={[s.row, item.person.isMe && s.meRow]}
          onPress={() => open(item.person.id)}
          accessibilityRole="button"
          accessibilityLabel={`${item.person.name}, ${item.localTime} in ${cityOf(item.timezone)}, ${formatDiff(item.diffMinutes)}`}
        >
          <View style={s.top}>
            <View style={[s.dot, { backgroundColor: tone(bucketOf(item)) }]} />
            <View style={s.body}>
              <Text style={s.name} numberOfLines={1}>{item.person.name}</Text>
              <Text style={s.meta} numberOfLines={1}>
                {item.person.isMe
                  ? `${cityOf(item.timezone)} · your day${model.me.fromProfile ? "" : " (this phone's time zone)"}`
                  : [cityOf(item.timezone), formatDiff(item.diffMinutes), item.overlap > 0 ? `${item.overlap}h shared` : "no shared hours"].join(" · ")}
              </Text>
            </View>
            <Text style={s.time}>{item.localTime}</Text>
          </View>
          <View style={s.track} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {AXIS.slice(1, -1).map((h) => <View key={h} style={[s.grid, { left: pct(h) }]} />)}
            <View style={[s.mine, { left: pct(WORK_START), width: pct(WORK_END - WORK_START) }]} />
            {item.spans.map(([from, to]) => (
              <View key={from} style={[s.span, { left: pct(from), width: pct(to - from), backgroundColor: item.overlap > 0 ? t.accent : t.textTertiary }]} />
            ))}
            <View style={[s.now, { left: pct(model.nowHour) }]} />
          </View>
        </PressableScale>
      )}
      ListFooterComponent={
        <View>
          {model.rows.length > 0 && sections.every((sec) => sec.isMe) ? <Text style={s.foot}>Nobody is available right now.</Text> : null}
          {model.unset.length > 0 ? <Text style={s.foot}>{`No time zone for ${model.unset.map((p) => p.name).join(", ")}.`}</Text> : null}
        </View>
      }
    />
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    list: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 48 },
    headerNote: { ...typeScale.caption, color: t.textTertiary },
    meRow: { borderColor: t.accent, backgroundColor: t.accentDim },
    header: { ...typeScale.overline, color: t.textTertiary, marginTop: 16, marginBottom: 6, marginLeft: 4 },
    row: {
      gap: 10, paddingVertical: 12, paddingHorizontal: 14,
      borderRadius: 12, backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, marginBottom: 6,
    },
    top: { flexDirection: "row", alignItems: "center", gap: 12 },
    axis: { height: 14, marginHorizontal: 15, marginBottom: 4 },
    tick: { ...typeScale.caption, position: "absolute", width: 20, marginLeft: -10, textAlign: "center", color: t.textTertiary, fontVariant: ["tabular-nums"] },
    tickStart: { marginLeft: 0, textAlign: "left" },
    tickEnd: { marginLeft: -20, textAlign: "right" },
    track: { height: 14, borderRadius: 4, backgroundColor: t.surface2, overflow: "hidden" },
    grid: { position: "absolute", top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: t.border },
    mine: { position: "absolute", top: 0, bottom: 0, backgroundColor: t.accentDim },
    span: { position: "absolute", top: 3, bottom: 3, borderRadius: 2 },
    now: { position: "absolute", top: 0, bottom: 0, width: 1.5, marginLeft: -0.75, backgroundColor: t.textPrimary },
    dot: { width: 10, height: 10, borderRadius: 5 },
    body: { flex: 1, gap: 2 },
    name: { ...typeScale.control, color: t.textPrimary },
    meta: { ...typeScale.caption, color: t.textTertiary },
    time: { ...typeScale.control, color: t.textPrimary, fontVariant: ["tabular-nums"] },
    foot: { ...typeScale.caption, color: t.textTertiary, marginTop: 14, marginLeft: 4 },
  });
}
