import { useMemo, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { WORKSPACE_ICON_NAMES, DEFAULT_PROJECT_ICON, resolveProjectIconName } from "@cairn/shared/ui/constants";
import { PROJECT_STATUSES } from "@cairn/shared/projects/defaults";
import { createProject, getProjectFields, updateProject } from "@/db/queries";
import { ModalSafeView } from "@/components/ModalSafeView";
import { ScreenChrome } from "@/components/screen-chrome";
import { PriorityChips } from "@/components/TaskChips";
import { ProjectIcon } from "@/components/ProjectIcon";
import { showProjectInSplitView } from "@/components/ProjectsSplitView";
import { ICON_CHECK } from "@/components/toolbar-icons";
import { toolbarPress, useModalOpenHaptic, haptics } from "@/haptics";
import { useTheme, type as typeScale, type Theme } from "@/theme";

const STATUS_LABEL: Record<(typeof PROJECT_STATUSES)[number], string> = {
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
};

/**
 * New project, or edit one (`id`). Creating adds the default board columns,
 * the same as desktop, and opens the new project.
 */
export default function ProjectForm() {
  useModalOpenHaptic();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const router = useRouter();
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const existing = useMemo(() => (id ? getProjectFields(id) : null), [id]);

  // What the form opened with. An edit saves only the fields that differ from this, so a
  // field a sync changed while the form was open isn't overwritten with its old value.
  const seed = useMemo(() => ({
    name: existing?.name ?? "",
    description: existing?.description ?? "",
    icon: resolveProjectIconName(existing?.icon ?? DEFAULT_PROJECT_ICON),
    status: existing?.status ?? "active",
    priority: existing?.priority ?? "medium",
  }), [existing]);
  const [name, setName] = useState(seed.name);
  const [description, setDescription] = useState(seed.description);
  const [icon, setIcon] = useState(seed.icon);
  const [status, setStatus] = useState(seed.status);
  const [priority, setPriority] = useState(seed.priority);
  const canSave = name.trim().length > 0;
  // Set on the first Save or keyboard submit, before the modal closes, so a second one is ignored.
  const submitting = useRef(false);

  const save = () => {
    if (!canSave || submitting.current) return;
    submitting.current = true;
    try {
      if (existing) {
        const current = { name, description, icon, status, priority };
        const changed = (Object.keys(current) as (keyof typeof current)[]).filter((k) => current[k] !== seed[k]);
        if (changed.length > 0) updateProject(existing.id, Object.fromEntries(changed.map((k) => [k, current[k]])));
        router.back();
        return;
      }
      const newId = createProject({ name, description, icon, status, priority });
      if (Platform.OS === "ios") {
        // The Projects tab is the split view on iOS: select the project there.
        showProjectInSplitView(newId);
        router.back();
      } else {
        router.replace({ pathname: "/project/[id]", params: { id: newId } });
      }
    } catch (e) {
      submitting.current = false; // let them fix it and try again
      Alert.alert(existing ? "Couldn't save the project" : "Couldn't create the project", e instanceof Error ? e.message : String(e));
    }
  };

  if (id && !existing) {
    return (
      <ModalSafeView backgroundColor={t.surface}>
        <ScreenChrome title="Project" />
        <Text style={[s.hint, { padding: 18 }]}>This project no longer exists.</Text>
      </ModalSafeView>
    );
  }

  // Keep the stored status when it is one the chips don't offer (e.g. "archived" from desktop).
  const statuses: string[] = [...PROJECT_STATUSES];
  if (!statuses.includes(status)) statuses.push(status);

  return (
    <ModalSafeView backgroundColor={t.surface}>
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScreenChrome
          title={existing ? "Edit Project" : "New Project"}
          right={[
            { kind: "button", key: "save", label: "Save", icon: ICON_CHECK, variant: "done", hidden: !canSave, onPress: () => toolbarPress(save, "confirm")() },
          ]}
        />
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          <Text style={s.label}>Name</Text>
          <TextInput
            style={s.titleInput}
            value={name}
            onChangeText={setName}
            placeholder="Project name"
            placeholderTextColor={t.textTertiary}
            autoFocus={!existing}
            returnKeyType="done"
            onSubmitEditing={save}
          />

          <Text style={s.label}>Icon</Text>
          <View style={s.iconGrid}>
            {WORKSPACE_ICON_NAMES.map((n) => {
              const on = n === icon;
              return (
                <Pressable
                  key={n}
                  onPress={() => { haptics.selection(); setIcon(n); }}
                  accessibilityRole="button"
                  accessibilityLabel={n}
                  accessibilityState={{ selected: on }}
                  style={[s.iconCell, { borderColor: on ? t.accent : t.border, backgroundColor: on ? t.accentDim : t.surface2 }]}
                >
                  <ProjectIcon name={n} size={20} color={on ? t.accent : t.textSecondary} />
                </Pressable>
              );
            })}
          </View>

          <Text style={s.label}>Status</Text>
          <View style={s.chipRow}>
            {statuses.map((st) => {
              const on = st === status;
              return (
                <Pressable
                  key={st}
                  onPress={() => setStatus(st)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  style={[s.chip, { borderColor: on ? t.accent : t.border }, on && { backgroundColor: t.accent }]}
                >
                  <Text style={[s.chipText, { color: on ? t.accentFg : t.textSecondary }]}>
                    {STATUS_LABEL[st as keyof typeof STATUS_LABEL] ?? st.replace(/_/g, " ")}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={s.label}>Priority</Text>
          <PriorityChips value={priority} onChange={setPriority} />

          <Text style={s.label}>Description</Text>
          <TextInput
            style={s.descInput}
            value={description}
            onChangeText={setDescription}
            placeholder="What is this project for?"
            placeholderTextColor={t.textTertiary}
            multiline
            textAlignVertical="top"
          />
          {!existing ? <Text style={s.hint}>New projects get the usual board columns: Backlog, Todo, In Progress, Review and Done.</Text> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </ModalSafeView>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    flex: { flex: 1 },
    content: { padding: 18, paddingBottom: 60 },
    label: { ...typeScale.overline, color: t.textTertiary, marginTop: 18, marginBottom: 8 },
    hint: { ...typeScale.caption, color: t.textTertiary, marginTop: 12 },
    titleInput: { ...typeScale.title, color: t.textPrimary, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12 },
    descInput: { ...typeScale.body, color: t.textPrimary, backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12, minHeight: 110 },
    iconGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    iconCell: { width: 44, height: 44, borderRadius: 10, borderWidth: 1, alignItems: "center", justifyContent: "center" },
    chipRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
    chip: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1 },
    chipText: { ...typeScale.label },
  });
}
