import { useMemo, useState } from "react";
import { Alert, Text, TextInput, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { X } from "lucide-react-native";
import { TEAM_KINDS, type Team, type TeamKind, type TeamLink, type TeamPatch } from "@cairn/shared/types/people";
import type { TeamNode } from "@cairn/shared/people/teams";
import { deleteTeam, loadTeamsView, mergeTeams, updateTeam } from "@/db/people";
import { ModalForm } from "@/components/ModalForm";
import { PickerList, type PickerOption as Option } from "@/components/PickerList";
import { PressableScale } from "@/components/PressableScale";
import { makeFormStyles } from "@/components/form-styles";
import { KIND_LABEL } from "@/lib/team-labels";
import { useModalResult } from "@/lib/use-modal-result";
import { useTheme } from "@/theme";

const isUrl = (s: string): boolean => {
  try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; }
};

type Draft = { name: string; kind: TeamKind; description: string; channel: string; leadPersonId: string; parentTeamId: string; links: TeamLink[] };

const seedOf = (team: Team): Draft => ({
  name: team.name, kind: team.kind, description: team.description ?? "", channel: team.channel ?? "",
  leadPersonId: team.leadPersonId ?? "", parentTeamId: team.parentTeamId ?? "", links: team.links,
});

function flattenKeys(node: TeamNode): string[] {
  return [node.group.key, ...node.children.flatMap(flattenKeys)];
}

/**
 * A team's details (a native modal), saved together with Save: name, kind, what it owns, channel, lead, the team it
 * sits under and its links (one list, saved whole). Merge and delete act at once after a confirm. The opener hears
 * `"saved"`, `{ keepId }` after a merge, or `"deleted"`.
 */
export default function TeamDetails() {
  const { id, resultKey } = useLocalSearchParams<{ id: string; resultKey?: string }>();
  const finish = useModalResult(resultKey);
  const t = useTheme();
  const s = useMemo(() => makeFormStyles(t), [t]);
  const view = useMemo(() => {
    try { return loadTeamsView(); } catch { return null; }
  }, []);
  const node = view?.nodes.find((n) => n.group.info?.id === id) ?? null;
  const team = node?.group.info ?? null;
  const [vals, setVals] = useState<Draft | null>(() => (team ? seedOf(team) : null));
  // What the form opened with: save sends only what the user changed, so a sync that landed meanwhile isn't overwritten.
  const [opened] = useState<Draft | null>(() => (team ? seedOf(team) : null));
  const [page, setPage] = useState<"form" | "lead" | "parent" | "merge">("form");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!view || !node || !team || !vals || !opened) return null;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setVals((v) => (v ? { ...v, [key]: value } : v));
    setError(null);
  };
  const { nodes, people } = view;

  // A team can't sit under itself or anything below it.
  const below = new Set(flattenKeys(node));
  const here = new Set(node.group.people.map((p) => p.id));
  const leadName = people.find((p) => p.id === vals.leadPersonId)?.name;
  const parentNode = nodes.find((n) => n.group.info?.id === vals.parentTeamId);
  const label = (n: TeamNode) => [...n.path, n.group.team].join(" › ");

  const addLink = () => {
    const url = linkUrl.trim();
    if (!isUrl(url)) return setError("Links need a full address, starting with https://");
    set("links", [...vals.links, { label: linkLabel.trim(), url }]);
    setLinkUrl("");
    setLinkLabel("");
  };

  const save = () => {
    if (!vals.name.trim()) return setError("A team needs a name.");
    const patch: TeamPatch = {};
    if (vals.name.trim() !== opened.name.trim()) patch.name = vals.name;
    if (vals.kind !== opened.kind) patch.kind = vals.kind;
    if (vals.description.trim() !== opened.description.trim()) patch.description = vals.description.trim() || null;
    if (vals.channel.trim() !== opened.channel.trim()) patch.channel = vals.channel.trim() || null;
    if (vals.leadPersonId !== opened.leadPersonId) patch.leadPersonId = vals.leadPersonId || null;
    if (vals.parentTeamId !== opened.parentTeamId) patch.parentTeamId = vals.parentTeamId || null;
    if (JSON.stringify(vals.links) !== JSON.stringify(opened.links)) patch.links = vals.links;
    try {
      if (Object.keys(patch).length) updateTeam(team.id, patch);
    } catch (e) {
      // A taken name, or a team under itself: say so and keep the form open.
      return setError(e instanceof Error ? e.message : String(e));
    }
    finish("saved");
  };

  const confirmDelete = () =>
    Alert.alert(`Delete ${team.name}?`, "Its members and history go with it. The people stay.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete team", style: "destructive",
        onPress: () => {
          try {
            deleteTeam(team.id);
          } catch (e) {
            return Alert.alert("Couldn't delete", e instanceof Error ? e.message : String(e));
          }
          finish("deleted");
        },
      },
    ]);

  const lead: Option[] = [
    { value: "", label: "No lead" },
    ...[...people].sort((a, b) => Number(here.has(b.id)) - Number(here.has(a.id)) || a.name.localeCompare(b.name))
      .map((p) => ({ value: p.id, label: p.name, note: here.has(p.id) ? "On this team" : p.title })),
  ];
  const parents: Option[] = [
    { value: "", label: "Nothing (a top-level team)" },
    ...nodes.filter((n) => n.group.info && !below.has(n.group.key)).map((n) => ({ value: n.group.info!.id, label: label(n) })),
  ];
  const merges: Option[] = nodes.filter((n) => n.group.info && n.group.info.id !== team.id)
    .map((n) => ({ value: n.group.info!.id, label: label(n), note: `${n.group.people.length} ${n.group.people.length === 1 ? "person" : "people"}` }));

  if (page !== "form") {
    return (
      <ModalForm title={page === "lead" ? "Lead" : page === "parent" ? "Sits under" : "Merge into"} onBack={() => setPage("form")} scroll={false}>
        {page === "lead" ? (
          <PickerList options={lead} selected={vals.leadPersonId} onPick={(v) => { set("leadPersonId", v); setPage("form"); }} />
        ) : page === "parent" ? (
          <PickerList options={parents} selected={vals.parentTeamId} onPick={(v) => { set("parentTeamId", v); setPage("form"); }} />
        ) : (
          <PickerList
            options={merges} empty="There is no other team to merge into."
            onPick={(keepId) => {
              const into = merges.find((m) => m.value === keepId)?.label ?? "that team";
              Alert.alert(`Merge ${team.name} into ${into}?`, "Its members with their roles and dates, and the teams under it, move to the other team. This team is removed.", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Merge", style: "destructive",
                  onPress: () => {
                    try {
                      mergeTeams(keepId, team.id);
                    } catch (e) {
                      return Alert.alert("Couldn't merge", e instanceof Error ? e.message : String(e));
                    }
                    finish({ keepId });
                  },
                },
              ]);
            }}
          />
        )}
      </ModalForm>
    );
  }

  return (
    <ModalForm title="Team details" onSave={save}>
      <Text style={s.label}>Name</Text>
      <TextInput style={s.input} value={vals.name} onChangeText={(v) => set("name", v)} placeholder="Sync" placeholderTextColor={t.textTertiary} accessibilityLabel="Team name" />

      <Text style={[s.label, s.gap]}>Kind</Text>
      <View style={s.chips}>
        {TEAM_KINDS.map((k) => (
          <PressableScale key={k} onPress={() => set("kind", k)} style={[s.chip, vals.kind === k && s.chipOn]} accessibilityLabel={KIND_LABEL[k]}>
            <Text style={[s.chipText, vals.kind === k && { color: t.accent }]}>{KIND_LABEL[k]}</Text>
          </PressableScale>
        ))}
      </View>
      <Text style={s.hint}>Someone has one team. Guilds, projects and committees sit beside it.</Text>

      <Text style={[s.label, s.gap]}>What it owns</Text>
      <TextInput
        style={[s.input, { minHeight: 88, textAlignVertical: "top" }]}
        value={vals.description}
        onChangeText={(v) => set("description", v)}
        placeholder="Sync engine, mobile replication, the conflict copy rules"
        placeholderTextColor={t.textTertiary}
        multiline
        accessibilityLabel="What the team owns"
      />

      <Text style={[s.label, s.gap]}>Lead</Text>
      <PressableScale style={s.pick} onPress={() => setPage("lead")} accessibilityLabel={`Lead: ${leadName ?? "none"}`}>
        <Text style={[s.line, !leadName && { color: t.textTertiary }]}>{leadName ?? "Choose a lead"}</Text>
        <Text style={s.chevron}>›</Text>
      </PressableScale>

      <Text style={[s.label, s.gap]}>Sits under</Text>
      <PressableScale style={s.pick} onPress={() => setPage("parent")} accessibilityLabel={`Sits under: ${parentNode ? label(parentNode) : "nothing"}`}>
        <Text style={[s.line, !parentNode && { color: t.textTertiary }]} numberOfLines={1}>{parentNode ? label(parentNode) : "Nothing (a top-level team)"}</Text>
        <Text style={s.chevron}>›</Text>
      </PressableScale>

      <Text style={[s.label, s.gap]}>Channel</Text>
      <TextInput style={s.input} value={vals.channel} onChangeText={(v) => set("channel", v)} placeholder="#sync" placeholderTextColor={t.textTertiary} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Channel" />

      <Text style={[s.label, s.gap]}>Links</Text>
      {vals.links.map((l, i) => (
        <View key={`${l.url}-${i}`} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 }}>
          <Text style={[s.line, s.flex]} numberOfLines={1}>{l.label || l.url}</Text>
          <PressableScale hitSlop={10} onPress={() => set("links", vals.links.filter((_, j) => j !== i))} accessibilityLabel={`Remove ${l.label || l.url}`}>
            <X size={16} color={t.textTertiary} />
          </PressableScale>
        </View>
      ))}
      <TextInput style={s.input} value={linkUrl} onChangeText={setLinkUrl} placeholder="https://…" placeholderTextColor={t.textTertiary} autoCapitalize="none" autoCorrect={false} keyboardType="url" accessibilityLabel="Link address" />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }}>
        <TextInput style={[s.input, s.flex, { marginTop: 0 }]} value={linkLabel} onChangeText={setLinkLabel} placeholder="Name (optional)" placeholderTextColor={t.textTertiary} accessibilityLabel="Link name" />
        <PressableScale onPress={addLink} style={[s.chip, !linkUrl.trim() && { opacity: 0.4 }]} accessibilityLabel="Add link">
          <Text style={s.chipText}>Add</Text>
        </PressableScale>
      </View>

      {error ? <Text style={[s.empty, { color: t.danger, marginTop: 12 }]} accessibilityRole="alert">{error}</Text> : null}

      {merges.length > 0 ? (
        <PressableScale style={[s.pick, s.gap]} onPress={() => setPage("merge")} accessibilityLabel="Merge into another team">
          <Text style={s.line}>Merge into another team…</Text>
          <Text style={s.chevron}>›</Text>
        </PressableScale>
      ) : null}
      <PressableScale style={{ alignItems: "center", marginTop: 10, paddingVertical: 12 }} onPress={confirmDelete} accessibilityLabel="Delete team">
        <Text style={[s.line, { color: t.danger }]}>Delete team</Text>
      </PressableScale>
    </ModalForm>
  );
}
