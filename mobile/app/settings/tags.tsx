import { useCallback, useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { Trash2 } from "lucide-react-native";
import { ModalSafeView } from "@/components/ModalSafeView";
import { PressableScale } from "@/components/PressableScale";
import { haptics } from "@/haptics";
import { listTagsWithUsage, softDeleteTag, updateTag } from "@/db/queries";
import { useEdgePad } from "@/lib/use-edge-pad";
import { useTheme, withAlpha, type as typeScale, type Theme } from "@/theme";

/** The desktop tag palette (`TAG_PALETTE`): tag colours are user data, so they are not theme tokens. */
const COLORS = ["#6366f1", "#8b5cf6", "#a855f7", "#ec4899", "#f43f5e", "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6", "#64748b", "#78716c"];

type Tag = ReturnType<typeof listTagsWithUsage>[number];

/** Settings, Tags: rename, recolour and delete. Tags sync, so edits reach the other devices. */
export default function TagsSettingsScreen() {
  const t = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const edge = useEdgePad(18);
  const [tags, setTags] = useState<Tag[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const reload = useCallback(() => setTags(listTagsWithUsage()), []);
  useFocusEffect(reload);

  const open = (tag: Tag) => {
    haptics.selection();
    setOpenId(openId === tag.id ? null : tag.id);
    setDraft(tag.name);
  };
  const saveName = (tag: Tag) => {
    const name = draft.trim();
    if (name && name !== tag.name) {
      updateTag(tag.id, { name });
      reload();
    } else setDraft(tag.name);
  };
  const recolour = (tag: Tag, color: string) => {
    haptics.selection();
    updateTag(tag.id, { color });
    reload();
  };
  const remove = (tag: Tag) =>
    Alert.alert(
      `Delete "${tag.name}"?`,
      tag.uses > 0 ? `It is removed from ${tag.uses} ${tag.uses === 1 ? "item" : "items"} on every synced device.` : "No notes or tasks use it.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            softDeleteTag(tag.id);
            setOpenId(null);
            reload();
          },
        },
      ],
    );

  return (
    <ModalSafeView backgroundColor={t.surface}>
      <ScrollView style={s.flex} contentContainerStyle={[s.body, edge]} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">
        {tags.length === 0 ? <Text style={s.empty}>No tags yet. Add one from a note or task.</Text> : null}
        {tags.map((tag) => {
          const isOpen = openId === tag.id;
          return (
            <View key={tag.id} style={[s.card, isOpen && { borderColor: withAlpha(tag.color, 0.6) }]}>
              <PressableScale style={s.head} onPress={() => open(tag)} accessibilityRole="button" accessibilityLabel={`${tag.name}, ${tag.uses} uses`}>
                <View style={[s.dot, { backgroundColor: tag.color }]} />
                <Text style={s.name} numberOfLines={1}>{tag.name}</Text>
                <Text style={s.count}>{tag.uses}</Text>
              </PressableScale>
              {isOpen ? (
                <View style={s.editor}>
                  <TextInput
                    style={s.input}
                    value={draft}
                    onChangeText={setDraft}
                    onBlur={() => saveName(tag)}
                    onSubmitEditing={() => saveName(tag)}
                    returnKeyType="done"
                    autoCapitalize="none"
                    accessibilityLabel="Tag name"
                  />
                  <View style={s.swatches}>
                    {COLORS.map((c) => (
                      <PressableScale
                        key={c}
                        onPress={() => recolour(tag, c)}
                        style={[s.swatch, { backgroundColor: c }, c === tag.color && { borderColor: t.textPrimary }]}
                        accessibilityRole="button"
                        accessibilityState={{ selected: c === tag.color }}
                        accessibilityLabel={`Colour ${c}`}
                      >
                        <View />
                      </PressableScale>
                    ))}
                  </View>
                  <PressableScale style={s.delete} onPress={() => remove(tag)} accessibilityRole="button" accessibilityLabel={`Delete ${tag.name}`}>
                    <Trash2 size={16} color={t.danger} />
                    <Text style={s.deleteText}>Delete tag</Text>
                  </PressableScale>
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </ModalSafeView>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: t.surface },
    body: { padding: 18, gap: 8, paddingBottom: 80 },
    empty: { ...typeScale.caption, color: t.textTertiary },
    card: { backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, borderRadius: 12, overflow: "hidden" },
    head: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 12 },
    dot: { width: 14, height: 14, borderRadius: 999 },
    name: { ...typeScale.control, color: t.textPrimary, flex: 1 },
    count: { ...typeScale.caption, color: t.textTertiary, fontVariant: ["tabular-nums"] },
    editor: { gap: 12, paddingHorizontal: 12, paddingBottom: 12 },
    input: { ...typeScale.control, color: t.textPrimary, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12 },
    swatches: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    swatch: { width: 28, height: 28, borderRadius: 999, borderWidth: 2, borderColor: "transparent" },
    delete: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", paddingVertical: 6 },
    deleteText: { ...typeScale.control, color: t.danger },
  });
}
