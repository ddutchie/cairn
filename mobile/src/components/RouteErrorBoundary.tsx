import { View, Text, Pressable, StyleSheet, ScrollView } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { ErrorBoundaryProps } from "expo-router";
import { useTheme, type as typeScale } from "@/theme";

/**
 * Route-level error boundary. Exported as `ErrorBoundary` from the root and tab
 * layouts so one bad render (a markdown edge case, a malformed synced row)
 * shows a recoverable screen instead of white-screening the whole app. Kept
 * free of navigation/context dependencies: it may render above the providers.
 */
export function RouteErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const t = useTheme();
  const details = `${error.name}: ${error.message}${error.stack ? `\n\n${error.stack}` : ""}`;
  return (
    <View style={[styles.center, { backgroundColor: t.background }]}>
      <Text accessibilityRole="header" style={[typeScale.heading, { color: t.textPrimary }]}>
        Something went wrong
      </Text>
      <Text style={[typeScale.body, styles.body, { color: t.textSecondary }]}>
        This screen hit an error. Your notes and tasks are safe — try again, and if it keeps happening, copy the details
        and send them along.
      </Text>
      <ScrollView style={[styles.details, { backgroundColor: t.surface2, borderColor: t.borderSubtle }]}>
        <Text selectable style={[typeScale.caption, { color: t.textTertiary }]}>
          {error.message}
        </Text>
      </ScrollView>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          onPress={() => void retry()}
          style={[styles.button, { backgroundColor: t.accent }]}
        >
          <Text style={[typeScale.control, { color: t.accentFg }]}>Try again</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => void Clipboard.setStringAsync(details)}
          style={[styles.button, { backgroundColor: t.surface2 }]}
        >
          <Text style={[typeScale.control, { color: t.textPrimary }]}>Copy details</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  body: { marginTop: 8, textAlign: "center" },
  details: { marginTop: 16, maxHeight: 160, alignSelf: "stretch", borderRadius: 10, borderWidth: 1, padding: 12 },
  row: { flexDirection: "row", gap: 12, marginTop: 20 },
  button: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12 },
});
