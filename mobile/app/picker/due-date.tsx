import { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet, useColorScheme } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/build/react-navigation/elements";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { resolveSheetResult, discardSheetResult } from "@/lib/sheet-result";

/**
 * Native formSheet route for picking a card's due date. Wraps the native
 * DateTimePicker (spinner) and commits on an explicit Done button rather than on
 * the picker's onChange — this fixes two inline-mode problems: (1) tapping the
 * already-selected day fires no change event, so "today" was impossible to pick,
 * and (2) the inline picker had no dismissal affordance. The working date is
 * held locally; Done returns it, Clear returns null, Cancel discards.
 */
export default function DueDatePickerRoute() {
  const t = useTheme();
  const scheme = useColorScheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();
  const { resultKey, initial } = useLocalSearchParams<{ resultKey?: string; initial?: string }>();
  const [value, setValue] = useState<Date>(() => (initial ? new Date(initial) : new Date()));
  // The sheet content is short and static, so we keep it a plain View (no
  // ScrollView — its automatic content inset re-triggers a layout jump when the
  // sheet is dragged between detents, making the picker vanish). Pad by the
  // native header height so the content clears it.
  const headerHeight = useHeaderHeight();

  const done = (iso: string | null) => {
    if (resultKey) resolveSheetResult(resultKey, iso);
    router.back();
  };

  // Dismissed without choosing (swipe-down)? Drop the caller's pending handler.
  useEffect(() => {
    return () => {
      if (resultKey) discardSheetResult(resultKey);
    };
  }, [resultKey]);

  return (
    <View style={[styles.container, { backgroundColor: t.background }]}>
      <Stack.Screen options={{ title: "Due date" }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button accessibilityLabel="Cancel" onPress={() => router.back()}>
          Cancel
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button accessibilityLabel="Done" onPress={() => done(value.toISOString())}>
          Done
        </Stack.Toolbar.Button>
      </Stack.Toolbar>

      <View style={[styles.body, { paddingTop: headerHeight + 12 }]}>
        <DateTimePicker
          value={value}
          mode="date"
          display="spinner"
          themeVariant={scheme === "dark" ? "dark" : "light"}
          onValueChange={(_event, date) => {
            if (date) setValue(date);
          }}
          style={styles.picker}
        />

        <Pressable style={styles.clear} onPress={() => done(null)}>
          <Text style={styles.clearText}>Clear due date</Text>
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1 },
    // Top padding is applied inline (headerHeight + 12); bottom just breathes.
    body: { paddingBottom: 24 },
    picker: { alignSelf: "center" },
    clear: { alignItems: "center", paddingVertical: 14, marginHorizontal: 18, marginTop: 8 },
    clearText: { ...typeScale.body, fontWeight: "500", color: t.danger },
  });
}
