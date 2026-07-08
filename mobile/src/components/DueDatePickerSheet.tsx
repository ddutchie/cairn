import { useMemo, useState } from "react";
import { Text, Pressable, StyleSheet, useColorScheme } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { BottomSheet, BottomSheetHeader } from "./BottomSheet";

/**
 * A bottom-anchored sheet for picking a card's due date. Wraps the native
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
    <BottomSheet visible={visible} onClose={onClose}>
      <BottomSheetHeader title="Due date" onCancel={onClose} onDone={() => onDone(value.toISOString())} />

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
    </BottomSheet>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    picker: { alignSelf: "center" },
    clear: { alignItems: "center", paddingVertical: 12, marginHorizontal: 18, marginTop: 4 },
    clearText: { ...typeScale.body, fontWeight: "500", color: t.danger },
  });
}
