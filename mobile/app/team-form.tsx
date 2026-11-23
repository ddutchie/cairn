import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { TEAM_KINDS, type TeamKind } from "@cairn/shared/types/people";
import { createTeam } from "@/db/people";
import { KIND_LABEL } from "@/lib/team-labels";
import { ModalSafeView } from "@/components/ModalSafeView";
import { ScreenChrome } from "@/components/screen-chrome";
import { PressableScale } from "@/components/PressableScale";
import { ICON_CHECK } from "@/components/toolbar-icons";
import { toolbarPress, useModalOpenHaptic } from "@/haptics";
import { discardSheetResult, resolveSheetResult } from "@/lib/sheet-result";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/**
 * Name and kind for a new team. A native modal like the project form. Saving closes it and hands the new team's id
 * to whoever opened it (`resultKey`), which opens the team's page. A taken name is said, and the form stays open.
 */
export default function TeamForm() {
  useModalOpenHaptic();
  const { resultKey } = useLocalSearchParams<{ resultKey?: string }>();
  const router = useRouter();
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TeamKind>("team");
  const canSave = name.trim().length > 0;
  const submitting = useRef(false);

  // Dismissed without saving (swipe down)? Drop the opener's pending handler.
  useEffect(() => {
    return () => {
      if (resultKey) discardSheetResult(resultKey);
    };
  }, [resultKey]);

  const save = () => {
    if (!canSave || submitting.current) return;
    submitting.current = true;
    try {
      const team = createTeam({ name, kind });
      router.back();
      if (resultKey) resolveSheetResult(resultKey, team.id);
    } catch (e) {
      submitting.current = false; // let them fix the name and try again
      Alert.alert("Couldn't make the team", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ModalSafeView backgroundColor={t.surface}>
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScreenChrome
          title="New team"
          right={[
            { kind: "button", key: "save", label: "Save", icon: ICON_CHECK, variant: "done", hidden: !canSave, onPress: () => toolbarPress(save, "confirm")() },
          ]}
        />
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          <Text style={s.label}>Name</Text>
          <TextInput
            style={s.input}
            value={name}
            onChangeText={setName}
            placeholder="Sync"
            placeholderTextColor={t.textTertiary}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={save}
            accessibilityLabel="Team name"
          />
          <Text style={[s.label, { marginTop: 18 }]}>Kind</Text>
          <View style={s.chips}>
            {TEAM_KINDS.map((k) => (
              <PressableScale key={k} onPress={() => setKind(k)} style={[s.chip, kind === k && s.chipOn]} accessibilityRole="radio" accessibilityState={{ checked: kind === k }} accessibilityLabel={KIND_LABEL[k]}>
                <Text style={[s.chipText, kind === k && { color: t.accent }]}>{KIND_LABEL[k]}</Text>
              </PressableScale>
            ))}
          </View>
          <Text style={s.hint}>Someone has one team. Guilds, projects and committees sit beside it.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </ModalSafeView>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    flex: { flex: 1 },
    content: { padding: 18, paddingBottom: 60 },
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
