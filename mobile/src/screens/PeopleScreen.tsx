import { useCallback, useMemo, useState } from "react";
import { View, Text, SectionList, RefreshControl, StyleSheet } from "react-native";
import { useRouter, type Href } from "expo-router";
import { ScreenChrome } from "@/components/screen-chrome";
import { SegmentedControl } from "@/components/SegmentedControl";
import { NewTeamSheet } from "@/screens/NewTeamSheet";
import { TeamsList } from "@/screens/TeamsList";
import { PressableScale } from "@/components/PressableScale";
import { SearchField } from "@/components/SearchField";
import { EmptyState } from "@/components/EmptyState";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { requestSync } from "@/sync/controller";
import { haptics } from "@/haptics";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { loadGrouping, loadPeople, saveGrouping, setPersonStatus } from "@/db/people";
import { toolbarPress } from "@/haptics";
import { ICON_ADD, ICON_GROUP_BY } from "@/components/toolbar-icons";
import { RELATIONSHIP_LABELS } from "@cairn/shared/people/model";
import { LIST_GROUPINGS, groupPeopleBy, type ListGrouping } from "@cairn/shared/people/list-groups";
import { formatRelative } from "@cairn/shared/format/date";
import type { PersonSummary } from "@cairn/shared/types/people-view";

/**
 * People: everyone you work with, grouped by relationship (or team, location, last met,
 * name: a per-device choice) with you pinned first, plus the
 * suggestions Cairn found (an unknown attendee, an ambiguous name) waiting for
 * a confirm or a dismiss. Dismissed people are remembered so they don't come
 * back. A row opens the person page.
 */
export function PeopleScreen() {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [grouping, setGroupingState] = useState<ListGrouping>(loadGrouping);
  // Location and Last met read the clock, so the grouping is redone when the screen reloads.
  const [now, setNow] = useState(() => new Date());
  const [mode, setMode] = useState<"people" | "teams">("people");
  const [newTeam, setNewTeam] = useState(false);
  const setGrouping = (g: ListGrouping) => {
    setGroupingState(g);
    saveGrouping(g);
  };

  const load = useCallback(() => {
    try {
      setPeople(loadPeople(["confirmed", "suggested"]));
      setNow(new Date());
    } catch {
      setPeople([]);
    }
  }, []);
  useRefreshOnFocus(load);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await requestSync("pull-to-refresh");
    } catch {}
    load();
    setRefreshing(false);
  }, [load]);

  const sections = useMemo(() => {
    const confirmed = people.filter((p) => p.status === "confirmed");
    const suggested = people.filter((p) => p.status === "suggested");
    const groups = groupPeopleBy(confirmed, grouping, { query, now }).map((g) => ({ key: g.key, title: g.label, note: g.note, data: g.people }));
    const sug = suggested.filter((p) => !query || p.name.toLowerCase().includes(query.toLowerCase()));
    return sug.length ? [{ key: "suggested", title: "Suggested", note: undefined, data: sug }, ...groups] : groups;
  }, [people, query, grouping, now]);

  const decide = (p: PersonSummary, status: "confirmed" | "dismissed") => {
    haptics.selection();
    setPersonStatus(p.id, status);
    load();
  };


  const switcher = (
    <SegmentedControl
      // Fixed height only (a flex:1 basis collapses the native view); see ProjectViewSwitcher.
      style={s.switcher}
      tintColor={t.accent}
      fontStyle={{ color: t.textSecondary, fontSize: 14, fontWeight: "600" }}
      activeFontStyle={{ color: t.accentFg, fontSize: 14, fontWeight: "600" }}
      values={["People", "Teams"]}
      selectedIndex={mode === "people" ? 0 : 1}
      onChange={(e) => setMode(e.nativeEvent.selectedSegmentIndex === 1 ? "teams" : "people")}
    />
  );

  return (
    <View style={s.root}>
      <ScreenChrome
        title="People"
        right={mode === "teams"
          ? [{ kind: "button", key: "new-team", label: "New team", icon: ICON_ADD, onPress: toolbarPress(() => setNewTeam(true)) }]
          : [{
            kind: "menu",
            key: "group",
            label: "Group people",
            icon: ICON_GROUP_BY,
            actions: LIST_GROUPINGS.map((g) => ({ label: g.label, isOn: g.value === grouping, onPress: toolbarPress(() => setGrouping(g.value)) })),
          }]}
      />
      {mode === "teams" ? <TeamsList header={switcher} /> : (
      <SectionList
        sections={sections}
        keyExtractor={(p, i) => `${p.id}-${i}`}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={s.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.textTertiary} />}
        ListHeaderComponent={
          <View>
            {switcher}
            {people.length > 0 ? <SearchField value={query} onChangeText={setQuery} placeholder="Search people" containerStyle={s.search} /> : null}
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            title="No people yet"
            subtitle="People appear here when a meeting note lists attendees or you add someone on the desktop."
          />
        }
        renderSectionHeader={({ section }) => (
          <Text style={s.header}>
            {section.title}
            {section.note ? <Text style={s.headerNote}>{`  ${section.note}`}</Text> : null}
          </Text>
        )}
        renderItem={({ item, section }) => (
          <PressableScale
            style={s.row}
            onPress={() => router.push({ pathname: "/people/[id]", params: { id: item.id } } as Href)}
            accessibilityLabel={item.name}
          >
            <View style={s.body}>
              <Text style={s.name} numberOfLines={1}>{item.name}</Text>
              <Text style={s.meta} numberOfLines={1}>
                {[
                  item.title ?? "",
                  grouping === "team" ? "" : item.teams?.[0]?.name ?? item.team ?? "",
                  item.relationship.map((r) => r.label ?? RELATIONSHIP_LABELS[r.type]).join(", "),
                  item.lastMetAt ? `met ${formatRelative(item.lastMetAt)}` : "",
                ].filter(Boolean).join(" · ") || (section.key === "suggested" ? "Suggested" : " ")}
              </Text>
            </View>
            {section.key === "suggested" ? (
              <View style={s.actions}>
                <PressableScale hitSlop={8} onPress={() => decide(item, "confirmed")} accessibilityLabel={`Confirm ${item.name}`}>
                  <Text style={[s.action, { color: t.accent }]}>Confirm</Text>
                </PressableScale>
                <PressableScale hitSlop={8} onPress={() => decide(item, "dismissed")} accessibilityLabel={`Dismiss ${item.name}`}>
                  <Text style={[s.action, { color: t.textTertiary }]}>Dismiss</Text>
                </PressableScale>
              </View>
            ) : (
              <Text style={s.chevron}>›</Text>
            )}
          </PressableScale>
        )}
      />
      )}
      <NewTeamSheet
        visible={newTeam}
        onClose={() => setNewTeam(false)}
        onCreated={(id) => {
          setNewTeam(false);
          router.push({ pathname: "/people/team/[id]", params: { id } } as Href);
        }}
      />
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.background },
    list: { padding: 12, paddingBottom: 48 },
    switcher: { height: 36, marginBottom: 8 },
    search: { marginBottom: 8 },
    header: { ...typeScale.overline, color: t.textTertiary, marginTop: 16, marginBottom: 6, marginLeft: 4 },
    headerNote: { ...typeScale.caption, color: t.textTertiary },
    row: {
      flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14,
      borderRadius: 12, backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, marginBottom: 6,
    },
    body: { flex: 1, gap: 2 },
    name: { ...typeScale.control, color: t.textPrimary },
    meta: { ...typeScale.caption, color: t.textTertiary },
    actions: { flexDirection: "row", gap: 14 },
    action: { ...typeScale.caption, fontWeight: "600" },
    chevron: { fontSize: 20, color: t.textTertiary },
  });
}
