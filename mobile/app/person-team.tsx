import { useMemo, useState } from "react";
import { Alert, Text, TextInput } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { addTeamMember, loadPeople, loadPersonPage, loadTeams, mergePeople, moveToTeam } from "@/db/people";
import { ModalForm } from "@/components/ModalForm";
import { PickerList } from "@/components/PickerList";
import { makeFormStyles } from "@/components/form-styles";
import { KIND_LABEL } from "@/lib/team-labels";
import { useModalResult } from "@/lib/use-modal-result";
import { useTheme } from "@/theme";

/**
 * The person page's team actions as one native modal, by `mode`: "add" them to a team, "move" them to a new one by
 * name, or (for a suggestion) say they're the "same" person as someone you know. The opener hears `{ keepId }` after
 * a merge, else `"saved"`.
 */
export default function PersonTeam() {
  const { id, mode, resultKey } = useLocalSearchParams<{ id: string; mode: "add" | "move" | "same"; resultKey?: string }>();
  const finish = useModalResult(resultKey);
  const t = useTheme();
  const s = useMemo(() => makeFormStyles(t), [t]);
  const person = useMemo(() => {
    try { return id ? loadPersonPage(id)?.person ?? null : null; } catch { return null; }
  }, [id]);
  const [name, setName] = useState("");
  const teams = useMemo(() => {
    try { return person ? loadTeams().filter((tm) => !person.teams.some((x) => x.teamId === tm.id)) : []; } catch { return []; }
  }, [person]);
  const people = useMemo(() => {
    try { return loadPeople(["confirmed"]).filter((p) => p.id !== id); } catch { return []; }
  }, [id]);
  if (!person) return null;

  const failed = (title: string, e: unknown) => Alert.alert(title, e instanceof Error ? e.message : String(e));

  if (mode === "add") {
    return (
      <ModalForm title="Add to a team" scroll={false}>
        <PickerList
          options={teams.map((tm) => ({ value: tm.id, label: tm.name, note: tm.kind !== "team" ? KIND_LABEL[tm.kind] : undefined }))}
          empty="They are on every team."
          onPick={(teamId) => {
            try {
              addTeamMember({ teamId, personId: person.id });
            } catch (e) {
              return failed("Couldn't add", e);
            }
            finish("saved");
          }}
        />
      </ModalForm>
    );
  }

  if (mode === "same") {
    return (
      <ModalForm title="Same person as" scroll={false}>
        <PickerList
          options={people.map((p) => ({ value: p.id, label: p.name, note: p.title }))}
          empty="Nobody to pick yet."
          // The person you already have stays; this suggestion folds into them.
          onPick={(otherId) => {
            const other = people.find((p) => p.id === otherId);
            if (!other) return;
            Alert.alert(`Merge ${person.name} into ${other.name}?`, "Their meetings, notes, tasks and teams move over, and the name becomes an alias.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Merge", style: "destructive",
                onPress: () => {
                  try {
                    mergePeople(other.id, person.id);
                  } catch (e) {
                    return failed("Couldn't merge", e);
                  }
                  finish({ keepId: other.id });
                },
              },
            ]);
          }}
        />
      </ModalForm>
    );
  }

  const move = () => {
    if (!name.trim()) return;
    // A guild or project name is refused (a home team is a team): say so and keep the form open.
    try {
      moveToTeam(person.id, name);
    } catch (e) {
      return failed("Couldn't move", e);
    }
    finish("saved");
  };
  return (
    <ModalForm title="Move to a new team" onSave={name.trim() ? move : undefined}>
      <Text style={s.label}>Team</Text>
      <TextInput
        style={s.input}
        value={name}
        onChangeText={setName}
        placeholder="Sync"
        placeholderTextColor={t.textTertiary}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={move}
        accessibilityLabel="Team name"
      />
      <Text style={s.hint}>Takes them off their other teams (guilds, projects and committees stay). A name that is not a team yet makes one.</Text>
    </ModalForm>
  );
}
