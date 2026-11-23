import { useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Check } from "lucide-react-native";
import { CADENCE_LABELS, RELATIONSHIP_LABELS } from "@cairn/shared/people/model";
import { CADENCES, RELATIONSHIP_TYPES, type Cadence, type Relationship, type RelationshipType } from "@cairn/shared/types/people";
import { loadPerson, saveRelationship } from "@/db/people";
import { ModalForm } from "@/components/ModalForm";
import { PressableScale } from "@/components/PressableScale";
import { makeFormStyles } from "@/components/form-styles";
import { useModalResult } from "@/lib/use-modal-result";
import { useTheme } from "@/theme";

/**
 * Relationship types and a 1:1 cadence for a person (a native modal). Existing labels and provenance stay with the
 * types that remain selected; save applies only what was changed, on top of the latest person.
 */
export default function PersonRelationship() {
  const { id, resultKey } = useLocalSearchParams<{ id: string; resultKey?: string }>();
  const finish = useModalResult(resultKey);
  const t = useTheme();
  const s = useMemo(() => makeFormStyles(t), [t]);
  const person = useMemo(() => {
    try { return id ? loadPerson(id) : null; } catch { return null; }
  }, [id]);
  const opened = useMemo(() => ({ types: new Set<RelationshipType>((person?.relationship ?? []).map((r) => r.type)), cad: (person?.cadence ?? null) as Cadence | null }), [person]);
  const [types, setTypes] = useState<Set<RelationshipType>>(opened.types);
  const [cad, setCad] = useState<Cadence | null>(opened.cad);
  if (!person) return null;

  const toggle = (type: RelationshipType) =>
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  const save = () => {
    // Sync may have changed the person while this was open: remove only what the user unticked,
    // add only what they ticked, and keep the cadence they didn't touch.
    try {
      const latest = loadPerson(person.id);
      if (!latest) return Alert.alert("This person is gone", "They were merged into someone else or removed on another device. Close this and open their page again.");
      const removed = new Set([...opened.types].filter((x) => !types.has(x)));
      const kept = latest.relationship.filter((r) => !removed.has(r.type));
      const have = new Set(kept.map((r) => r.type));
      const added: Relationship[] = [...types].filter((x) => !opened.types.has(x) && !have.has(x)).map((type) => ({ type, provenance: "explicit" }));
      saveRelationship(person.id, [...kept, ...added], cad !== opened.cad ? cad : latest.cadence ?? null);
    } catch (e) {
      // The draft stays, so they can try again.
      return Alert.alert("Couldn't save", e instanceof Error ? e.message : String(e));
    }
    finish("saved");
  };

  return (
    <ModalForm title="Relationship" onSave={save}>
      <Text style={s.label}>Relationship to you</Text>
      <View style={s.chips}>
        {RELATIONSHIP_TYPES.map((type) => (
          <PressableScale key={type} onPress={() => toggle(type)} style={[s.chip, types.has(type) && s.chipOn]} accessibilityRole="checkbox" accessibilityState={{ checked: types.has(type) }} accessibilityLabel={RELATIONSHIP_LABELS[type]}>
            {types.has(type) ? <Check size={12} color={t.accent} /> : null}
            <Text style={[s.chipText, types.has(type) && { color: t.accent }]}>{RELATIONSHIP_LABELS[type]}</Text>
          </PressableScale>
        ))}
      </View>
      <Text style={[s.label, { marginTop: 22 }]}>1:1 cadence</Text>
      <View style={s.chips}>
        {([null, ...CADENCES] as (Cadence | null)[]).map((c) => (
          <PressableScale key={c ?? "none"} onPress={() => setCad(c)} style={[s.chip, cad === c && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: cad === c }} accessibilityLabel={c ? CADENCE_LABELS[c] : "No cadence"}>
            <Text style={[s.chipText, cad === c && { color: t.accent }]}>{c ? CADENCE_LABELS[c] : "None"}</Text>
          </PressableScale>
        ))}
      </View>
    </ModalForm>
  );
}
