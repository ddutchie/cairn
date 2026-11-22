import { useCallback, useMemo, useState } from "react";
import { View, Text, FlatList, RefreshControl, StyleSheet } from "react-native";
import { useRouter, type Href } from "expo-router";
import { PressableScale } from "@/components/PressableScale";
import { SearchField } from "@/components/SearchField";
import { EmptyState } from "@/components/EmptyState";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { requestSync } from "@/sync/controller";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { loadTeamsView, type TeamsView } from "@/db/people";
import { KIND_LABEL, peopleCount } from "@/lib/team-labels";
import { NO_TEAM_KEY } from "@cairn/shared/people/teams";

type Row = { kind: "team"; key: string; name: string; depth: number; teamKind: string | null; count: number; lead: string | null } | { kind: "none"; count: number };

/**
 * The Teams half of the People tab: teams nested under the team they sit
 * under (the shared `teamForest`), each with its kind when it isn't a plain
 * team, who leads it and how many are on it, then everyone without a team.
 * A row opens the team's page.
 */
export function TeamsList() {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();
  const [view, setView] = useState<TeamsView | null>(null);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    try {
      setView(loadTeamsView());
    } catch {
      setView(null);
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

  const rows = useMemo<Row[]>(() => {
    if (!view) return [];
    const q = query.trim().toLowerCase();
    const byId = new Map(view.people.map((p) => [p.id, p.name]));
    const out: Row[] = [];
    for (const n of view.nodes) {
      const { group } = n;
      // While searching the tree is flat: a match shouldn't hide under an unmatched parent.
      if (q && !group.team.toLowerCase().includes(q)) continue;
      out.push({
        kind: "team", key: group.key, name: group.team, depth: q ? 0 : n.path.length,
        teamKind: group.info && group.info.kind !== "team" ? KIND_LABEL[group.info.kind] : null,
        count: group.people.length,
        lead: group.info?.leadPersonId ? byId.get(group.info.leadPersonId) ?? null : null,
      });
    }
    const none = view.groups.find((g) => g.key === NO_TEAM_KEY);
    if (none && !q) out.push({ kind: "none", count: none.people.length });
    return out;
  }, [view, query]);

  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => (r.kind === "team" ? r.key : "none")}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={s.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.textTertiary} />}
      ListHeaderComponent={
        <View>
          {view && view.nodes.length > 0 ? <SearchField value={query} onChangeText={setQuery} placeholder="Search teams" containerStyle={s.search} /> : null}
        </View>
      }
      ListEmptyComponent={
        view ? (
          <EmptyState
            title="No teams yet"
            subtitle="Add one with the + button, or put a team on someone's page."
          />
        ) : undefined
      }
      renderItem={({ item }) =>
        item.kind === "none" ? (
          <View style={[s.row, s.rowNone]}>
            <Text style={s.none}>Without a team</Text>
            <Text style={s.count}>{item.count}</Text>
          </View>
        ) : (
          <PressableScale
            style={[s.row, { marginLeft: Math.min(item.depth, 4) * 16 }]}
            onPress={() => router.push({ pathname: "/workspace/people/team/[id]", params: { id: item.key } } as Href)}
            accessibilityLabel={`${item.name}, ${peopleCount(item.count)}`}
          >
            <View style={s.body}>
              <View style={s.nameRow}>
                <Text style={s.name} numberOfLines={1}>{item.name}</Text>
                {item.teamKind ? <View style={s.badge}><Text style={s.badgeText}>{item.teamKind}</Text></View> : null}
              </View>
              <Text style={s.meta} numberOfLines={1}>{[item.lead ? `Led by ${item.lead}` : "", peopleCount(item.count)].filter(Boolean).join(" · ")}</Text>
            </View>
            <Text style={s.chevron}>›</Text>
          </PressableScale>
        )
      }
    />
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    list: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 48 },
    search: { marginTop: 8, marginBottom: 8 },
    row: {
      flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14,
      borderRadius: 12, backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, marginBottom: 6,
    },
    rowNone: { backgroundColor: "transparent", justifyContent: "space-between", marginTop: 10 },
    none: { ...typeScale.caption, color: t.textTertiary },
    count: { ...typeScale.caption, color: t.textTertiary },
    body: { flex: 1, gap: 2 },
    nameRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    name: { ...typeScale.control, color: t.textPrimary, flexShrink: 1 },
    badge: { paddingHorizontal: 7, paddingVertical: 1, borderRadius: 8, backgroundColor: t.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
    badgeText: { ...typeScale.caption, fontSize: 11, color: t.textSecondary },
    meta: { ...typeScale.caption, color: t.textTertiary },
    chevron: { fontSize: 20, color: t.textTertiary },
  });
}
