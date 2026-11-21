import { useCallback, useMemo, useState } from "react";
import { Alert, Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { ICON_EDIT, ICON_PEOPLE } from "@/components/toolbar-icons";
import { ScreenChrome } from "@/components/screen-chrome";
import { PressableScale } from "@/components/PressableScale";
import { NotFound } from "@/components/NotFound";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { haptics, toolbarPress } from "@/haptics";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { createTeam, deleteTeam, loadTeamsView, mergeTeams, type TeamsView } from "@/db/people";
import { TeamDetailsSheet, TeamMembersSheet } from "@/screens/TeamSheets";
import { KIND_LABEL, peopleCount } from "@/lib/team-labels";
import { foldTeamName } from "@cairn/shared/people/team-queries";
import { RELATIONSHIP_LABELS } from "@cairn/shared/people/model";
import { formatDate } from "@cairn/shared/format/date";
import type { TeamNode } from "@cairn/shared/people/teams";

/**
 * A team's page: what it owns, who leads it, where it sits (the teams above it, by id), how to
 * reach it, who is on it with their role, and who used to be. Edit opens the details; Members
 * opens the member list. Both save with Done, like the person page's sheets.
 *
 * The route param is the team's group key: its id, or `name:<folded name>` for a team that is
 * only a name on people, which gets its row the first time you edit it.
 */
export function TeamScreen() {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();
  const { id, open } = useLocalSearchParams<{ id: string; open?: string }>();
  const [view, setView] = useState<TeamsView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sheet, setSheet] = useState<"details" | "members" | null>(open === "details" || open === "members" ? open : null);

  const load = useCallback(() => {
    try {
      setView(loadTeamsView());
    } catch {
      setView(null);
    }
    setLoaded(true);
  }, []);
  useRefreshOnFocus(load);

  const node = useMemo<TeamNode | null>(() => {
    if (!view || !id) return null;
    return view.nodes.find((n) => n.group.key === id) ?? view.nodes.find((n) => foldTeamName(n.group.team) === foldTeamName(id.replace(/^name:/, ""))) ?? null;
  }, [view, id]);

  if (loaded && !node) return <NotFound label="Team" />;
  if (!view || !node) return <View style={s.root} />;

  const { group, children } = node;
  const info = group.info;
  const byId = new Map(view.people.map((p) => [p.id, p]));
  const lead = info?.leadPersonId ? byId.get(info.leadPersonId) : undefined;
  const zones = group.timezones.length;
  const twin = info ? view.nodes.find((n) => n.group.info && n.group.key !== group.key && foldTeamName(n.group.team) === foldTeamName(group.team)) : undefined;
  // The teams above this one, by their ids, so two teams with one name each open the right parent.
  const ancestors: TeamNode[] = [];
  for (let pid = info?.parentTeamId; pid;) {
    const up = view.nodes.find((n) => n.group.key === pid);
    if (!up || ancestors.includes(up)) break;
    ancestors.unshift(up);
    pid = up.group.info?.parentTeamId;
  }
  const meta = [
    info && info.kind !== "team" ? KIND_LABEL[info.kind] : null,
    peopleCount(group.people.length),
    zones > 1 ? `${zones} time zones` : null,
    children.length ? `${children.length} ${children.length === 1 ? "team" : "teams"} below` : null,
  ].filter(Boolean).join(" · ");
  const here = new Set(group.people.map((p) => p.id));
  const past = info
    ? view.memberships
        .filter((m) => m.teamId === info.id && m.endedAt && !here.has(m.personId) && byId.has(m.personId))
        .sort((a, b) => b.endedAt!.localeCompare(a.endedAt!))
    : [];

  const openTeam = (key: string) => router.push({ pathname: "/workspace/people/team/[id]", params: { id: key } } as Href);
  const openPerson = (personId: string) => router.push({ pathname: "/workspace/people/[id]", params: { id: personId } } as Href);

  // A team that is only a name on people gets its row now, so the details have somewhere to live;
  // the page then reopens on the new id with the sheet showing.
  const start = (which: "details" | "members") => {
    if (info) return setSheet(which);
    try {
      const made = createTeam({ name: group.team });
      router.replace({ pathname: "/workspace/people/team/[id]", params: { id: made.id, open: which } } as Href);
    } catch (e) {
      Alert.alert("Couldn't add details", e instanceof Error ? e.message : String(e));
    }
  };

  const saved = () => {
    haptics.selection();
    setSheet(null);
    load();
  };

  const mergeTwin = () => {
    if (!info || !twin?.group.info) return;
    const other = twin.group.info;
    Alert.alert(`Merge ${other.name} into this team?`, "Its members, their roles and dates, and the teams under it move here. The other team is removed.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Merge", style: "destructive",
        onPress: () => {
          try {
            mergeTeams(info.id, other.id);
            haptics.selection();
          } catch (e) {
            Alert.alert("Couldn't merge", e instanceof Error ? e.message : String(e));
          }
          load();
        },
      },
    ]);
  };

  return (
    <View style={s.root}>
      <ScreenChrome
        title={group.team}
        right={[
          { kind: "button", key: "members", label: "Members", icon: ICON_PEOPLE, onPress: toolbarPress(() => start("members")) },
          { kind: "button", key: "edit", label: info ? "Edit" : "Add details", icon: ICON_EDIT, onPress: toolbarPress(() => start("details")) },
        ]}
      />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={s.content}>
        {ancestors.length > 0 ? (
          <View style={s.crumbs} accessibilityLabel="Teams above">
            {ancestors.map((a) => (
              <PressableScale key={a.group.key} onPress={() => openTeam(a.group.key)} accessibilityLabel={a.group.team}>
                <Text style={s.crumb}>{a.group.team} ›</Text>
              </PressableScale>
            ))}
          </View>
        ) : null}
        <Text style={s.name}>{group.team}</Text>
        <Text style={s.meta}>{meta}</Text>

        {twin?.group.info ? (
          <View style={s.banner} accessibilityRole="summary">
            <Text style={s.bannerText}>
              Another team is also called {group.team}, with {peopleCount(twin.group.people.length)}. Two devices probably made it before they synced.
            </Text>
            <PressableScale onPress={mergeTwin} accessibilityLabel="Merge into this one">
              <Text style={[s.action, { color: t.accent }]}>Merge into this one</Text>
            </PressableScale>
          </View>
        ) : null}

        {info?.description ? (
          <Text style={s.description}>{info.description}</Text>
        ) : (
          <Text style={s.empty}>Nothing about what this team owns yet. Add details, or ask the assistant to fill them in from your notes.</Text>
        )}

        {lead || info?.channel || (info?.links.length ?? 0) > 0 ? (
          <View style={s.facts}>
            {lead ? (
              <View style={s.fact}>
                <Text style={s.factLabel}>Lead</Text>
                <PressableScale onPress={() => openPerson(lead.id)} accessibilityLabel={`Lead: ${lead.name}`}>
                  <Text style={[s.line, { color: t.accent }]}>{lead.name}</Text>
                </PressableScale>
              </View>
            ) : null}
            {info?.channel ? (
              <View style={s.fact}>
                <Text style={s.factLabel}>Channel</Text>
                <Text style={s.line}>{info.channel.startsWith("#") ? info.channel : `#${info.channel}`}</Text>
              </View>
            ) : null}
            {info?.links.map((l) => (
              <View key={l.url} style={s.fact}>
                <Text style={s.factLabel}>Link</Text>
                <PressableScale style={s.flex} onPress={() => void Linking.openURL(l.url).catch(() => {})} accessibilityLabel={l.label || l.url}>
                  <Text style={[s.line, { color: t.accent }]} numberOfLines={1}>{l.label || l.url}</Text>
                </PressableScale>
              </View>
            ))}
          </View>
        ) : null}

        {children.length > 0 ? (
          <Section title={`Teams below · ${children.length}`} s={s}>
            {children.map((c) => (
              <PressableScale key={c.group.key} style={s.row} onPress={() => openTeam(c.group.key)} accessibilityLabel={c.group.team}>
                <Text style={[s.line, s.flex]} numberOfLines={1}>{c.group.team}</Text>
                <Text style={s.count}>{c.group.people.length}</Text>
              </PressableScale>
            ))}
          </Section>
        ) : null}

        <Section title={`Members · ${group.people.length}`} s={s}>
          {group.people.length === 0 ? <Text style={s.empty}>Nobody is on this team yet.</Text> : null}
          {[...group.people].sort((a, b) => Number(b.id === info?.leadPersonId) - Number(a.id === info?.leadPersonId)).map((p) => {
            const rel = p.relationship[0];
            const sub = [group.roles[p.id] ?? p.title, rel ? rel.label ?? RELATIONSHIP_LABELS[rel.type] : null].filter(Boolean).join(" · ");
            return (
              <PressableScale key={p.id} style={s.row} onPress={() => openPerson(p.id)} accessibilityLabel={p.name}>
                <View style={s.flex}>
                  <Text style={s.line} numberOfLines={1}>
                    {p.name}{p.isMe ? " (you)" : ""}
                    {p.id === info?.leadPersonId ? <Text style={s.lead}>{"  Lead"}</Text> : null}
                  </Text>
                  {sub ? <Text style={s.sub} numberOfLines={1}>{sub}</Text> : null}
                </View>
                <Text style={s.chevron}>›</Text>
              </PressableScale>
            );
          })}
        </Section>

        {past.length > 0 ? (
          <Section title={`Past members · ${past.length}`} s={s}>
            {past.map((m) => (
              <PressableScale key={m.id} style={s.row} onPress={() => openPerson(m.personId)} accessibilityLabel={byId.get(m.personId)!.name}>
                <Text style={[s.sub, s.flex]} numberOfLines={1}>{byId.get(m.personId)!.name}</Text>
                <Text style={s.sub}>{m.startedAt ? `${formatDate(m.startedAt)} – ` : "Left "}{formatDate(m.endedAt!)}</Text>
              </PressableScale>
            ))}
          </Section>
        ) : null}
      </ScrollView>

      {info ? (
        <>
          <TeamDetailsSheet
            visible={sheet === "details"}
            node={node}
            nodes={view.nodes}
            people={view.people}
            onClose={() => setSheet(null)}
            onSaved={saved}
            onMerge={(keepId) => {
              try {
                mergeTeams(keepId, info.id);
              } catch (e) {
                Alert.alert("Couldn't merge", e instanceof Error ? e.message : String(e));
                return;
              }
              setSheet(null);
              router.replace({ pathname: "/workspace/people/team/[id]", params: { id: keepId } } as Href);
            }}
            onDelete={() => {
              try {
                deleteTeam(info.id);
              } catch (e) {
                Alert.alert("Couldn't delete", e instanceof Error ? e.message : String(e));
                return;
              }
              setSheet(null);
              router.back();
            }}
          />
          <TeamMembersSheet visible={sheet === "members"} node={node} people={view.people} onClose={() => setSheet(null)} onSaved={saved} />
        </>
      ) : null}
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function Section({ title, children, s }: { title: string; children: React.ReactNode; s: Styles }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.background },
    flex: { flex: 1 },
    content: { padding: 18, paddingBottom: 64 },
    crumbs: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 4 },
    crumb: { ...typeScale.caption, color: t.textTertiary },
    name: { ...typeScale.display, color: t.textPrimary },
    meta: { ...typeScale.caption, color: t.textTertiary, marginTop: 4 },
    banner: {
      marginTop: 14, padding: 12, gap: 8, borderRadius: 10, backgroundColor: t.surface2,
      borderWidth: StyleSheet.hairlineWidth, borderColor: t.border,
    },
    bannerText: { ...typeScale.caption, color: t.textSecondary },
    action: { ...typeScale.caption, fontWeight: "600" },
    description: { ...typeScale.body, color: t.textSecondary, marginTop: 14 },
    empty: { ...typeScale.body, color: t.textTertiary, marginTop: 14 },
    facts: { marginTop: 16, gap: 8 },
    fact: { flexDirection: "row", alignItems: "center", gap: 12 },
    factLabel: { ...typeScale.caption, color: t.textTertiary, width: 56 },
    section: { marginTop: 28, gap: 6 },
    sectionTitle: { ...typeScale.overline, color: t.textTertiary },
    row: {
      flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 11, paddingHorizontal: 14,
      borderRadius: 12, backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border,
    },
    line: { ...typeScale.body, color: t.textPrimary },
    sub: { ...typeScale.caption, color: t.textTertiary },
    lead: { ...typeScale.caption, color: t.textTertiary },
    count: { ...typeScale.caption, color: t.textTertiary },
    chevron: { fontSize: 20, color: t.textTertiary },
  });
}
