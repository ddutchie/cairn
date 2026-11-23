import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { RELATIONSHIP_LABELS } from "@cairn/shared/people/model";
import { RELATIONSHIP_TYPES, type RelationshipType } from "@cairn/shared/types/people";
import { createPerson } from "@/db/people";
import { ModalSafeView } from "@/components/ModalSafeView";
import { ScreenChrome } from "@/components/screen-chrome";
import { PressableScale } from "@/components/PressableScale";
import { PlaceField } from "@/components/PlaceField";
import { ICON_CHECK } from "@/components/toolbar-icons";
import { toolbarPress, useModalOpenHaptic } from "@/haptics";
import { discardSheetResult, resolveSheetResult } from "@/lib/sheet-result";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/**
 * Add a person, as the desktop's Add person form: name, relationship to you and, optionally, role, team, location,
 * time zone and "This is me". A native modal like the project form. Saving closes it and hands the new person's id
 * to whoever opened it (`resultKey`), which opens their page.
 */
export default function PersonForm() {
  useModalOpenHaptic();
  const { resultKey } = useLocalSearchParams<{ resultKey?: string }>();
  const router = useRouter();
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const [name, setName] = useState("");
  // null is "No relationship yet", the desktop's default.
  const [rel, setRel] = useState<RelationshipType | null>(null);
  const [title, setTitle] = useState("");
  const [team, setTeam] = useState("");
  const [location, setLocation] = useState("");
  const [timezone, setTimezone] = useState("");
  const [isMe, setIsMe] = useState(false);
  const canSave = name.trim().length > 0;
  // Set on the first Save or keyboard submit, before the modal closes, so a second one is ignored.
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
      const person = createPerson({
        name,
        relationship: rel ? [{ type: rel, provenance: "explicit" }] : [],
        title,
        team,
        location,
        timezone,
        isMe,
      });
      router.back();
      if (resultKey) resolveSheetResult(resultKey, person.id);
    } catch (e) {
      submitting.current = false; // let them fix it and try again
      Alert.alert("Couldn't add the person", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ModalSafeView backgroundColor={t.surface}>
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScreenChrome
          title="Add person"
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
            placeholder="Ana Lopez"
            placeholderTextColor={t.textTertiary}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={save}
            accessibilityLabel="Person's name"
          />

          <Text style={s.label}>Relationship to you</Text>
          <View style={s.chips}>
            <PressableScale onPress={() => setRel(null)} style={[s.chip, rel === null && s.chipOn]} accessibilityLabel="No relationship yet">
              <Text style={[s.chipText, rel === null && { color: t.accent }]}>No relationship yet</Text>
            </PressableScale>
            {RELATIONSHIP_TYPES.map((type) => (
              <PressableScale key={type} onPress={() => setRel(type)} style={[s.chip, rel === type && s.chipOn]} accessibilityLabel={RELATIONSHIP_LABELS[type]}>
                <Text style={[s.chipText, rel === type && { color: t.accent }]}>{RELATIONSHIP_LABELS[type]}</Text>
              </PressableScale>
            ))}
          </View>

          <Text style={s.label}>Role</Text>
          <TextInput
            style={s.input}
            value={title}
            onChangeText={setTitle}
            placeholder="Senior software engineer"
            placeholderTextColor={t.textTertiary}
            returnKeyType="done"
            accessibilityLabel="Role"
          />
          <Text style={s.label}>Team</Text>
          <TextInput
            style={s.input}
            value={team}
            onChangeText={setTeam}
            placeholder="Sync"
            placeholderTextColor={t.textTertiary}
            returnKeyType="done"
            accessibilityLabel="Team"
          />
          <Text style={s.label}>Location</Text>
          <PlaceField
            mode="location"
            value={location}
            placeholder="Berlin, Germany"
            accessibilityLabel="Location"
            onChangeText={setLocation}
            onPick={(text, zone) => {
              setLocation(text);
              // As on the desktop: a place that names a zone fills an empty time zone, never one that is set.
              if (zone && !timezone.trim()) setTimezone(zone);
            }}
          />
          <Text style={s.label}>Time zone</Text>
          <PlaceField
            mode="timezone"
            value={timezone}
            placeholder="Europe/Berlin, or a city"
            accessibilityLabel="Time zone"
            onChangeText={setTimezone}
            onPick={(text) => setTimezone(text)}
          />

          <View style={s.toggleRow}>
            <View style={s.toggleText}>
              <Text style={s.toggleTitle}>This is me</Text>
              <Text style={s.hint}>Relationships like direct report or peer link people to you on the map. Only one person can be you.</Text>
            </View>
            <Switch value={isMe} onValueChange={setIsMe} accessibilityLabel="This is me" trackColor={{ false: t.border, true: t.accent }} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </ModalSafeView>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    flex: { flex: 1 },
    content: { padding: 18, paddingBottom: 60 },
    label: { ...typeScale.overline, color: t.textTertiary, marginTop: 18 },
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
    toggleRow: {
      flexDirection: "row", alignItems: "center", marginTop: 22, paddingVertical: 12, paddingHorizontal: 14,
      borderRadius: 12, backgroundColor: t.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border,
    },
    toggleText: { flex: 1, paddingRight: 12 },
    toggleTitle: { ...typeScale.body, color: t.textPrimary, fontWeight: "600" },
    hint: { ...typeScale.caption, color: t.textTertiary, marginTop: 3 },
  });
}
