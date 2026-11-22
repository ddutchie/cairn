import { useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { X } from "lucide-react-native";
import { BottomSheet, BottomSheetHeader } from "@/components/BottomSheet";
import { PressableScale } from "@/components/PressableScale";
import { PickerPage, type PickerOption as Option } from "@/components/PickerPage";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { addTeamMember, endTeamMember, updateTeam } from "@/db/people";
import { KIND_LABEL } from "@/lib/team-labels";
import { TEAM_KINDS, type Team, type TeamKind, type TeamLink, type TeamPatch } from "@cairn/shared/types/people";
import type { PersonSummary } from "@cairn/shared/types/people-view";
import type { TeamNode } from "@cairn/shared/people/teams";

const isUrl = (s: string): boolean => {
  try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; }
};

type Draft = { name: string; kind: TeamKind; description: string; channel: string; leadPersonId: string; parentTeamId: string; links: TeamLink[] };

const seedOf = (team: Team): Draft => ({
  name: team.name, kind: team.kind, description: team.description ?? "", channel: team.channel ?? "",
  leadPersonId: team.leadPersonId ?? "", parentTeamId: team.parentTeamId ?? "", links: team.links,
});

/**
 * A team's details, saved together with Done: name, kind, what it owns, channel, lead, the team
 * it sits under and its links (one list, saved whole). Merge and delete act at once after a confirm.
 */
export function TeamDetailsSheet({ visible, node, nodes, people, onClose, onSaved, onMerge, onDelete }: {
  visible: boolean; node: TeamNode; nodes: TeamNode[]; people: PersonSummary[];
  onClose: () => void; onSaved: () => void; onMerge: (keepId: string) => void; onDelete: () => void;
}) {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const team = node.group.info!;
  const [vals, setVals] = useState<Draft>(() => seedOf(team));
  // What the sheet opened with: save sends only what the user changed, so a sync that landed meanwhile isn't overwritten.
  const [opened, setOpened] = useState<Draft>(() => seedOf(team));
  const [page, setPage] = useState<"form" | "lead" | "parent" | "merge">("form");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [wasVisible, setWasVisible] = useState(false);
  if (visible && !wasVisible) {
    setWasVisible(true);
    setVals(seedOf(team));
    setOpened(seedOf(team));
    setPage("form");
    setLinkUrl("");
    setLinkLabel("");
    setError(null);
  } else if (!visible && wasVisible) {
    setWasVisible(false);
  }
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setVals((v) => ({ ...v, [key]: value }));
    setError(null);
  };

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
      // A taken name, or a team under itself: say so and keep the sheet open.
      return setError(e instanceof Error ? e.message : String(e));
    }
    onSaved();
  };

  const confirmDelete = () =>
    Alert.alert(`Delete ${team.name}?`, "Its members and history go with it. The people stay.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete team", style: "destructive", onPress: onDelete },
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

  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeight="88%" avoidKeyboard>
      {page === "lead" ? (
        <PickerPage title="Lead" options={lead} selected={vals.leadPersonId} onBack={() => setPage("form")} onPick={(v) => { set("leadPersonId", v); setPage("form"); }} />
      ) : page === "parent" ? (
        <PickerPage title="Sits under" options={parents} selected={vals.parentTeamId} onBack={() => setPage("form")} onPick={(v) => { set("parentTeamId", v); setPage("form"); }} />
      ) : page === "merge" ? (
        <PickerPage
          title="Merge into" options={merges} empty="There is no other team to merge into."
          onBack={() => setPage("form")}
          onPick={(keepId) => {
            const into = merges.find((m) => m.value === keepId)?.label ?? "that team";
            Alert.alert(`Merge ${team.name} into ${into}?`, "Its members with their roles and dates, and the teams under it, move to the other team. This team is removed.", [
              { text: "Cancel", style: "cancel" },
              { text: "Merge", style: "destructive", onPress: () => onMerge(keepId) },
            ]);
          }}
        />
      ) : (
        <>
          <BottomSheetHeader title="Team details" onCancel={onClose} onDone={save} />
          <ScrollView contentContainerStyle={s.sheet} keyboardShouldPersistTaps="handled">
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
              <View key={`${l.url}-${i}`} style={s.linkRow}>
                <Text style={[s.line, s.flex]} numberOfLines={1}>{l.label || l.url}</Text>
                <PressableScale hitSlop={10} onPress={() => set("links", vals.links.filter((_, j) => j !== i))} accessibilityLabel={`Remove ${l.label || l.url}`}>
                  <X size={16} color={t.textTertiary} />
                </PressableScale>
              </View>
            ))}
            <TextInput style={s.input} value={linkUrl} onChangeText={setLinkUrl} placeholder="https://…" placeholderTextColor={t.textTertiary} autoCapitalize="none" autoCorrect={false} keyboardType="url" accessibilityLabel="Link address" />
            <View style={s.linkAdd}>
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
            <PressableScale style={s.delete} onPress={confirmDelete} accessibilityLabel="Delete team">
              <Text style={[s.line, { color: t.danger }]}>Delete team</Text>
            </PressableScale>
          </ScrollView>
        </>
      )}
    </BottomSheet>
  );
}

function flattenKeys(node: TeamNode): string[] {
  return [node.group.key, ...node.children.flatMap(flattenKeys)];
}

/**
 * Who is on a team, saved together with Done: add people, take people off (kept as history) and
 * set each one's role. Adding never takes anyone off another team.
 */
export function TeamMembersSheet({ visible, node, people, onClose, onSaved }: {
  visible: boolean; node: TeamNode; people: PersonSummary[]; onClose: () => void; onSaved: () => void;
}) {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const team = node.group.info!;
  const leadId = team.leadPersonId;
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [opened, setOpened] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<PersonSummary[]>([]);
  const [adding, setAdding] = useState(false);
  const [wasVisible, setWasVisible] = useState(false);
  if (visible && !wasVisible) {
    setWasVisible(true);
    const seed = Object.fromEntries(node.group.people.map((p) => [p.id, node.group.roles[p.id] ?? ""]));
    setRoles(seed);
    setOpened(seed);
    setRemoved(new Set());
    setAdded([]);
    setAdding(false);
  } else if (!visible && wasVisible) {
    setWasVisible(false);
  }

  // A person can be in both lists (added here, then synced onto the team): show them once.
  const base = new Set(node.group.people.map((p) => p.id));
  const draft = added.filter((p) => !base.has(p.id));
  const members = [
    ...[...node.group.people].sort((a, b) => Number(b.id === leadId) - Number(a.id === leadId)),
    ...draft,
  ].filter((p) => !removed.has(p.id));
  const taken = new Set(members.map((p) => p.id));
  const options: Option[] = people.filter((p) => !taken.has(p.id)).map((p) => ({ value: p.id, label: p.name, note: p.team ? `On ${p.team}` : p.title }));

  const save = () => {
    try {
      for (const p of node.group.people) {
        if (removed.has(p.id)) endTeamMember(team.id, p.id);
        else if ((roles[p.id] ?? "").trim() !== (opened[p.id] ?? "").trim()) addTeamMember({ teamId: team.id, personId: p.id, role: (roles[p.id] ?? "").trim() || null });
      }
      for (const p of draft) if (!removed.has(p.id)) addTeamMember({ teamId: team.id, personId: p.id, role: (roles[p.id] ?? "").trim() || undefined });
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof Error ? e.message : String(e));
      return;
    }
    onSaved();
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeight="88%" avoidKeyboard>
      {adding ? (
        <PickerPage
          title="Add a member" options={options} empty="Everyone is on this team."
          onBack={() => setAdding(false)}
          onPick={(id) => {
            const p = people.find((x) => x.id === id);
            if (p) {
              // Adding back someone just taken off undoes the removal instead of hiding the row.
              setRemoved((r) => { const n = new Set(r); n.delete(p.id); return n; });
              if (!base.has(p.id)) setAdded((a) => (a.some((x) => x.id === p.id) ? a : [...a, p]));
            }
            setAdding(false);
          }}
        />
      ) : (
        <>
          <BottomSheetHeader title="Members" onCancel={onClose} onDone={save} />
          <ScrollView contentContainerStyle={s.sheet} keyboardShouldPersistTaps="handled">
            {members.length === 0 ? <Text style={s.empty}>Nobody is on this team yet.</Text> : null}
            {members.map((p) => (
              <View key={p.id} style={s.memberRow}>
                <View style={s.flex}>
                  <Text style={s.line} numberOfLines={1}>{p.name}{p.isMe ? " (you)" : ""}</Text>
                  <TextInput
                    style={[s.input, s.roleInput]}
                    value={roles[p.id] ?? ""}
                    onChangeText={(v) => setRoles((r) => ({ ...r, [p.id]: v }))}
                    placeholder="Role"
                    placeholderTextColor={t.textTertiary}
                    accessibilityLabel={`${p.name}'s role`}
                  />
                </View>
                <PressableScale hitSlop={10} onPress={() => setRemoved((r) => new Set([...r, p.id]))} accessibilityLabel={`Take ${p.name} off ${team.name}`}>
                  <X size={18} color={t.textTertiary} />
                </PressableScale>
              </View>
            ))}
            <PressableScale style={[s.pick, s.gap]} onPress={() => setAdding(true)} accessibilityLabel="Add a member">
              <Text style={[s.line, { color: t.accent }]}>Add a member…</Text>
            </PressableScale>
          </ScrollView>
        </>
      )}
    </BottomSheet>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    flex: { flex: 1 },
    sheet: { padding: 18, paddingBottom: 32 },
    gap: { marginTop: 16 },
    label: { ...typeScale.overline, color: t.textTertiary },
    input: {
      ...typeScale.body, color: t.textPrimary, marginTop: 6, paddingVertical: 10, paddingHorizontal: 12,
      borderRadius: 10, backgroundColor: t.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border,
    },
    roleInput: { marginTop: 4, paddingVertical: 6 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
    chip: {
      paddingVertical: 5, paddingHorizontal: 11, borderRadius: 14, backgroundColor: t.surface2,
      borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, justifyContent: "center",
    },
    chipOn: { borderColor: t.accent, backgroundColor: t.accentDim },
    chipText: { ...typeScale.caption, color: t.textSecondary, fontWeight: "600" },
    hint: { ...typeScale.caption, color: t.textTertiary, marginTop: 8 },
    pick: {
      flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6, paddingVertical: 12, paddingHorizontal: 12,
      borderRadius: 10, backgroundColor: t.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border,
    },
    delete: { alignItems: "center", marginTop: 10, paddingVertical: 12 },
    line: { ...typeScale.body, color: t.textPrimary },
    note: { ...typeScale.caption, color: t.textTertiary },
    empty: { ...typeScale.body, color: t.textTertiary },
    chevron: { ...typeScale.title, fontWeight: "400", color: t.textTertiary },
    linkRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
    linkAdd: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
    memberRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
  });
}
