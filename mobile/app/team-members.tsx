import { useMemo, useState } from "react";
import { Alert, Text, TextInput, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { X } from "lucide-react-native";
import type { PersonSummary } from "@cairn/shared/types/people-view";
import { loadTeamsView, saveTeamMembers } from "@/db/people";
import { ModalForm } from "@/components/ModalForm";
import { PickerList, type PickerOption as Option } from "@/components/PickerList";
import { PressableScale } from "@/components/PressableScale";
import { makeFormStyles } from "@/components/form-styles";
import { useModalResult } from "@/lib/use-modal-result";
import { useTheme } from "@/theme";

/**
 * Who is on a team (a native modal), saved together with Save: add people, take people off (kept as history) and set
 * each one's role. Adding never takes anyone off another team.
 */
export default function TeamMembers() {
  const { id, resultKey } = useLocalSearchParams<{ id: string; resultKey?: string }>();
  const finish = useModalResult(resultKey);
  const t = useTheme();
  const s = useMemo(() => makeFormStyles(t), [t]);
  const view = useMemo(() => {
    try { return loadTeamsView(); } catch { return null; }
  }, []);
  const node = view?.nodes.find((n) => n.group.info?.id === id) ?? null;
  const team = node?.group.info ?? null;
  // What the form opened with: save sends only what changed.
  const opened = useMemo<Record<string, string>>(
    () => Object.fromEntries((node?.group.people ?? []).map((p) => [p.id, node?.group.roles[p.id] ?? ""])),
    [node],
  );
  const [roles, setRoles] = useState<Record<string, string>>(opened);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<PersonSummary[]>([]);
  const [adding, setAdding] = useState(false);
  if (!view || !node || !team) return null;

  // A person can be in both lists (added here, then synced onto the team): show them once.
  const base = new Set(node.group.people.map((p) => p.id));
  const draft = added.filter((p) => !base.has(p.id));
  const members = [
    ...[...node.group.people].sort((a, b) => Number(b.id === team.leadPersonId) - Number(a.id === team.leadPersonId)),
    ...draft,
  ].filter((p) => !removed.has(p.id));
  const taken = new Set(members.map((p) => p.id));
  const options: Option[] = view.people.filter((p) => !taken.has(p.id)).map((p) => ({ value: p.id, label: p.name, note: p.team ? `On ${p.team}` : p.title }));

  const save = () => {
    const role = (id: string) => (roles[id] ?? "").trim() || null;
    try {
      // One commit: a person deleted by sync since the picker loaded must not leave half the edits saved.
      saveTeamMembers({
        teamId: team.id,
        end: node.group.people.filter((p) => removed.has(p.id)).map((p) => p.id),
        set: [
          ...node.group.people.filter((p) => !removed.has(p.id) && (roles[p.id] ?? "").trim() !== (opened[p.id] ?? "").trim()).map((p) => ({ personId: p.id, role: role(p.id) })),
          // An empty role clears a past stint's old one rather than bringing it back.
          ...draft.filter((p) => !removed.has(p.id)).map((p) => ({ personId: p.id, role: role(p.id) })),
        ],
      });
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof Error ? e.message : String(e));
      return;
    }
    finish("saved");
  };

  if (adding) {
    return (
      <ModalForm title="Add a member" onBack={() => setAdding(false)} scroll={false}>
        <PickerList
          options={options}
          empty="Everyone is on this team."
          onPick={(pid) => {
            const p = view.people.find((x) => x.id === pid);
            if (p) {
              // Adding back someone just taken off undoes the removal instead of hiding the row.
              setRemoved((r) => { const n = new Set(r); n.delete(p.id); return n; });
              if (!base.has(p.id)) setAdded((a) => (a.some((x) => x.id === p.id) ? a : [...a, p]));
            }
            setAdding(false);
          }}
        />
      </ModalForm>
    );
  }

  return (
    <ModalForm title="Members" onSave={save}>
      {members.length === 0 ? <Text style={s.empty}>Nobody is on this team yet.</Text> : null}
      {members.map((p) => (
        <View key={p.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 }}>
          <View style={s.flex}>
            <Text style={s.line} numberOfLines={1}>{p.name}{p.isMe ? " (you)" : ""}</Text>
            <TextInput
              style={[s.input, { marginTop: 4, paddingVertical: 6 }]}
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
    </ModalForm>
  );
}
