import { useMemo, useState } from "react";
import { View, Text, Pressable, FlatList, StyleSheet } from "react-native";
import { Check } from "lucide-react-native";
import { listAllTags, type TagRow } from "@/db/queries";
import { useTheme, withAlpha, type as typeScale, type Theme } from "@/theme";
import { BottomSheet, BottomSheetHeader } from "./BottomSheet";

/**
 * A bottom-anchored sheet for selecting a note/card's tags. Presents every
 * workspace tag as a toggleable row (coloured dot + name + check). Selection is
 * held locally and returned via onDone so the caller can persist it in one
 * write (setNoteTags / setCardTags).
 */
export function TagPickerSheet({
  visible,
  initialSelected,
  onDone,
  onClose,
}: {
  visible: boolean;
  initialSelected: string[];
  onDone: (tagIds: string[]) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const allTags: TagRow[] = useMemo(() => (visible ? listAllTags() : []), [visible]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelected));

  // Reset the working selection whenever the sheet re-opens.
  const [wasVisible, setWasVisible] = useState(false);
  if (visible && !wasVisible) {
    setSelected(new Set(initialSelected));
    setWasVisible(true);
  } else if (!visible && wasVisible) {
    setWasVisible(false);
  }

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const done = () => onDone([...selected]);

  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeight="70%">
      <BottomSheetHeader title="Tags" onCancel={onClose} onDone={done} />

      {allTags.length === 0 ? (
        <Text style={styles.empty}>No tags in this workspace yet.</Text>
      ) : (
        <FlatList
          data={allTags}
          keyExtractor={(tag) => tag.id}
          style={styles.list}
          renderItem={({ item }) => {
            const on = selected.has(item.id);
            return (
              <Pressable
                style={[styles.row, on && { backgroundColor: withAlpha(item.color, 0.1) }]}
                onPress={() => toggle(item.id)}
              >
                <View style={[styles.dot, { backgroundColor: item.color }]} />
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                {on && <Check size={18} color={t.accent} />}
              </Pressable>
            );
          }}
        />
      )}
    </BottomSheet>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    list: { paddingHorizontal: 10 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 12,
      borderRadius: 10,
    },
    dot: { width: 12, height: 12, borderRadius: 6 },
    name: { flex: 1, ...typeScale.body, color: t.textPrimary },
    empty: { color: t.textTertiary, textAlign: "center", padding: 28, ...typeScale.caption },
  });
}
