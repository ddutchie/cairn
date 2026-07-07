import { useMemo, useState } from "react";
import { Modal, View, Text, Pressable, FlatList, StyleSheet } from "react-native";
import { Check } from "lucide-react-native";
import { listAllTags, type TagRow } from "@/db/queries";
import { useTheme, withAlpha, elevation, type Theme } from "@/theme";

/**
 * A bottom-anchored modal for selecting a note/card's tags. Presents every
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
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, elevation.xl]}>
        <View style={styles.grabber} />
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>Tags</Text>
          <Pressable onPress={done} hitSlop={12}>
            <Text style={styles.done}>Done</Text>
          </Pressable>
        </View>

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
      </View>
    </Modal>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: withAlpha("#000000", 0.4) },
    sheet: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      maxHeight: "70%",
      backgroundColor: t.surface,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      paddingBottom: 34,
    },
    grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: t.border, marginTop: 8 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 18,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    title: { fontSize: 16, fontWeight: "700", color: t.textPrimary },
    cancel: { fontSize: 16, color: t.textTertiary },
    done: { fontSize: 16, fontWeight: "600", color: t.accent },
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
    name: { flex: 1, fontSize: 15, color: t.textPrimary },
    empty: { color: t.textTertiary, textAlign: "center", padding: 28, fontSize: 14 },
  });
}
