import { useMemo, useState } from "react";
import { Alert, Text, TextInput, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { PROFILE_FIELDS, type ProfileField } from "@cairn/shared/people/parse";
import { cleanProfileFieldWithPlaces, zoneForPlace } from "@cairn/shared/people/place-zone";
import type { PersonSummary } from "@cairn/shared/types/people-view";
import { loadPeople, loadPerson, mergePeople, saveProfile, type ProfileEdit } from "@/db/people";
import { ModalForm } from "@/components/ModalForm";
import { PickerList } from "@/components/PickerList";
import { PlaceField } from "@/components/PlaceField";
import { PressableScale } from "@/components/PressableScale";
import { makeFormStyles } from "@/components/form-styles";
import { useModalResult } from "@/lib/use-modal-result";
import { useTheme } from "@/theme";

const FIELD_LABEL: Record<ProfileField, string> = { title: "Role", team: "Team", location: "Location", timezone: "Time zone" };

/**
 * A person's role, team, location, time zone and Slack id (a native modal; place fields suggest as you type), plus
 * "Same person as…" to fold a duplicate into them. Save sends only what changed, so a sync that landed meanwhile isn't
 * overwritten. The opener hears `{ keepId }` (the page to show) after a merge, else `"saved"`.
 */
export default function PersonDetails() {
  const { id, resultKey } = useLocalSearchParams<{ id: string; resultKey?: string }>();
  const finish = useModalResult(resultKey);
  const t = useTheme();
  const s = useMemo(() => makeFormStyles(t), [t]);
  const person = useMemo(() => {
    try { return id ? loadPerson(id) : null; } catch { return null; }
  }, [id]);
  const seed = useMemo<ProfileEdit>(
    () => ({ title: person?.title ?? "", team: person?.team ?? "", location: person?.location ?? "", timezone: person?.timezone ?? "", slackId: person?.slackId ?? "" }),
    [person],
  );
  const [vals, setVals] = useState<ProfileEdit>(seed);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  // The time zone in the draft was filled in from a location, not typed: it is only a suggestion at Save.
  const [tzInferred, setTzInferred] = useState(false);
  // Whoever this could be a duplicate of: anyone else but you (merging drops them, and "you" must stay).
  const others = useMemo<PersonSummary[]>(() => {
    try {
      return loadPeople(["confirmed", "suggested"]).filter((p) => p.id !== id && !p.isMe);
    } catch {
      return [];
    }
  }, [id]);
  if (!person) return null;

  const set = (key: keyof ProfileEdit) => (text: string) => {
    setVals((v) => ({ ...v, [key]: text }));
    if (key === "timezone") setTzInferred(false);
    setError(null);
  };
  const save = () => {
    // Work out what the user changed first, then tidy only those fields: an untouched field is never rewritten,
    // so a sync that landed while this was open isn't overwritten by a re-tidied copy of the old value.
    const edited = (k: keyof ProfileEdit) => vals[k].trim() !== seed[k].trim();
    const patch: Partial<ProfileEdit> = {};
    for (const f of PROFILE_FIELDS) {
      if (!edited(f) || (f === "timezone" && tzInferred)) continue;
      const { value, error: err } = cleanProfileFieldWithPlaces(f, vals[f]);
      if (err) return setError(err);
      patch[f] = value ?? ""; // a blank is an explicit clear
    }
    if (edited("slackId")) {
      if (vals.slackId.trim() && !/^[A-Za-z0-9]{3,32}$/.test(vals.slackId.trim())) return setError("A Slack id looks like U01ABCDEF.");
      patch.slackId = vals.slackId.trim();
    }
    try {
      // As on the desktop, a changed location fills an empty time zone: a zone from the suggestion, or one worked out
      // from the typed place. It is only a guess, so it is written only if the stored zone is still empty (sync may
      // have set one meanwhile), and never when the user typed or cleared the time zone themselves.
      const guess = tzInferred
        ? cleanProfileFieldWithPlaces("timezone", vals.timezone).value
        : !edited("timezone") && !seed.timezone.trim() && edited("location") && patch.location ? zoneForPlace(patch.location) : null;
      if (guess && !loadPerson(person.id)?.timezone) patch.timezone = guess;
      // A team name that is a guild or project is refused (a home team is a team): say so and keep the form open.
      saveProfile(person.id, patch);
    } catch (e) {
      return Alert.alert("Couldn't save", e instanceof Error ? e.message : String(e));
    }
    finish("saved");
  };

  if (picking) {
    return (
      <ModalForm title="Same person as" onBack={() => setPicking(false)} scroll={false}>
        <PickerList
          options={others.map((p) => ({ value: p.id, label: p.name, note: p.status === "suggested" ? "Suggested" : p.title }))}
          onPick={(otherId) => {
            const other = others.find((p) => p.id === otherId);
            if (!other) return;
            Alert.alert(`Merge ${other.name} into ${person.name}?`, "Their meetings, notes, tasks and teams move over, and the name becomes an alias.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Merge", style: "destructive",
                onPress: () => {
                  try {
                    mergePeople(person.id, other.id);
                  } catch (e) {
                    return Alert.alert("Couldn't merge", e instanceof Error ? e.message : String(e));
                  }
                  finish({ keepId: person.id });
                },
              },
            ]);
          }}
        />
      </ModalForm>
    );
  }

  const input = (key: keyof ProfileEdit, label: string, placeholder: string) => (
    <View key={key} style={s.gap}>
      <Text style={s.label}>{label}</Text>
      {key === "location" || key === "timezone" ? (
        <PlaceField
          mode={key}
          value={vals[key]}
          placeholder={placeholder}
          accessibilityLabel={label}
          onChangeText={set(key)}
          onPick={(text, zone) => {
            // A place that names a zone fills an empty time zone, never one that is set.
            const fill = key === "location" && !!zone && !vals.timezone.trim();
            setVals((v) => ({ ...v, [key]: text, ...(fill ? { timezone: zone } : {}) }));
            if (key === "timezone") setTzInferred(false);
            else if (fill) setTzInferred(true);
            setError(null);
          }}
        />
      ) : (
        <TextInput
          style={s.input}
          value={vals[key]}
          onChangeText={set(key)}
          placeholder={placeholder}
          placeholderTextColor={t.textTertiary}
          autoCapitalize={key === "slackId" ? "none" : "sentences"}
          autoCorrect={false}
          accessibilityLabel={label}
        />
      )}
    </View>
  );

  return (
    <ModalForm title="Details" onSave={save}>
      {input("title", FIELD_LABEL.title, "Senior software engineer")}
      {input("team", FIELD_LABEL.team, "Sync")}
      {input("location", FIELD_LABEL.location, "Berlin, Germany")}
      {input("timezone", FIELD_LABEL.timezone, "Europe/Berlin")}
      {input("slackId", "Slack id", "U01ABCDEF")}
      {error ? <Text style={[s.empty, { color: t.danger, marginTop: 12 }]} accessibilityRole="alert">{error}</Text> : null}
      {others.length > 0 ? (
        <View style={{ marginTop: 22 }}>
          <Text style={s.label}>Duplicate</Text>
          <PressableScale style={s.pick} onPress={() => setPicking(true)} accessibilityLabel="Same person as…">
            <Text style={s.line}>Same person as…</Text>
            <Text style={s.chevron}>›</Text>
          </PressableScale>
          <Text style={s.hint}>Their meetings, notes, tasks and teams move here; their name becomes an alias.</Text>
        </View>
      ) : null}
    </ModalForm>
  );
}
