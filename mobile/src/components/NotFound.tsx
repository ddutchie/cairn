import { View, Text, StyleSheet } from "react-native";
import { useTheme } from "@/theme";

/**
 * Centered "<label> not found" placeholder for leaf detail screens whose target
 * row is missing (deleted, bad id, not yet synced). Shared by the note and card
 * detail screens, which rendered the same centered `textTertiary` message.
 */
export function NotFound({ label }: { label: string }) {
  const t = useTheme();
  return (
    <View style={[styles.center, { backgroundColor: t.background }]}>
      <Text style={{ color: t.textTertiary }}>{label} not found</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
