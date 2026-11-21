import { useMemo, useState } from "react";
import { Alert, Text, TextInput, View, StyleSheet } from "react-native";
import { BottomSheet, BottomSheetHeader } from "@/components/BottomSheet";
import { PressableScale } from "@/components/PressableScale";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { createTeam } from "@/db/people";
import { KIND_LABEL } from "@/lib/team-labels";
import { TEAM_KINDS, type TeamKind } from "@cairn/shared/types/people";

/** Name and kind for a new team; Done makes it and hands back its id. A taken name is said, and the sheet stays open. */
export function NewTeamSheet({ visible, onClose, onCreated }: { visible: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TeamKind>("team");
  // Start blank each time the sheet opens.
  const [wasVisible, setWasVisible] = useState(false);
  if (visible && !wasVisible) {
    setWasVisible(true);
    setName("");
    setKind("team");
  } else if (!visible && wasVisible) {
    setWasVisible(false);
  }
  const save = () => {
    try {
      onCreated(createTeam({ name, kind }).id);
    } catch (e) {
      Alert.alert("Couldn't make the team", e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <BottomSheet visible={visible} onClose={onClose} avoidKeyboard>
      <BottomSheetHeader title="New team" onCancel={onClose} onDone={name.trim() ? save : undefined} />
      <View style={s.body}>
        <Text style={s.label}>Name</Text>
        <TextInput
          style={s.input}
          value={name}
          onChangeText={setName}
          placeholder="Sync"
          placeholderTextColor={t.textTertiary}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={name.trim() ? save : undefined}
          accessibilityLabel="Team name"
        />
        <Text style={[s.label, { marginTop: 16 }]}>Kind</Text>
        <View style={s.chips}>
          {TEAM_KINDS.map((k) => (
            <PressableScale key={k} onPress={() => setKind(k)} style={[s.chip, kind === k && s.chipOn]} accessibilityLabel={KIND_LABEL[k]}>
              <Text style={[s.chipText, kind === k && { color: t.accent }]}>{KIND_LABEL[k]}</Text>
            </PressableScale>
          ))}
        </View>
        <Text style={s.hint}>Someone has one team. Guilds, projects and committees sit beside it.</Text>
      </View>
    </BottomSheet>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    body: { padding: 18, paddingBottom: 24 },
    label: { ...typeScale.overline, color: t.textTertiary },
    input: {
      ...typeScale.body, color: t.textPrimary, marginTop: 6, paddingVertical: 10, paddingHorizontal: 12,
      borderRadius: 10, backgroundColor: t.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border,
    },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
    chip: {
      paddingVertical: 5, paddingHorizontal: 11, borderRadius: 14, backgroundColor: t.surface2,
      borderWidth: StyleSheet.hairlineWidth, borderColor: t.border,
    },
    chipOn: { borderColor: t.accent, backgroundColor: t.accentDim },
    chipText: { ...typeScale.caption, color: t.textSecondary, fontWeight: "600" },
    hint: { ...typeScale.caption, color: t.textTertiary, marginTop: 12 },
  });
}
