import { useMemo, useState } from "react";
import { Modal, View, Text, Pressable, StyleSheet, useColorScheme } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useTheme, elevation, withAlpha, type Theme } from "@/theme";

/**
 * A bottom-anchored modal for picking a card's due date. Wraps the native
 * DateTimePicker (spinner) and commits on an explicit Done button rather than
 * on the picker's onChange — this fixes two inline-mode problems: (1) tapping
 * the already-selected day fires no change event, so "today" was impossible to
 * pick, and (2) the inline picker had no dismissal affordance. The working date
 * is held locally; Done returns it, Clear returns null, Cancel discards.
 */
export function DueDatePickerSheet({
  visible,
  initial,
  onDone,
  onClose,
}: {
  visible: boolean;
  initial: string | null;
  onDone: (iso: string | null) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const scheme = useColorScheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const [value, setValue] = useState<Date>(() => (initial ? new Date(initial) : new Date()));

  // Reset the working value each time the sheet re-opens.
  const [wasVisible, setWasVisible] = useState(false);
  if (visible && !wasVisible) {
    setValue(initial ? new Date(initial) : new Date());
    setWasVisible(true);
  } else if (!visible && wasVisible) {
    setWasVisible(false);
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, elevation.xl]}>
        <View style={styles.grabber} />
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>Due date</Text>
          <Pressable onPress={() => onDone(value.toISOString())} hitSlop={12}>
            <Text style={styles.done}>Done</Text>
          </Pressable>
        </View>

        <DateTimePicker
          value={value}
          mode="date"
          display="spinner"
          themeVariant={scheme === "dark" ? "dark" : "light"}
          onChange={(_event, date) => {
            if (date) setValue(date);
          }}
          style={styles.picker}
        />

        <Pressable style={styles.clear} onPress={() => onDone(null)}>
          <Text style={styles.clearText}>Clear due date</Text>
        </Pressable>
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
    picker: { alignSelf: "center" },
    clear: { alignItems: "center", paddingVertical: 12, marginHorizontal: 18, marginTop: 4 },
    clearText: { fontSize: 15, color: t.danger, fontWeight: "500" },
  });
}
