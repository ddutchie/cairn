import type { ReactNode } from "react";
import { StyleSheet, View, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "@/theme";

/**
 * Shared screen scaffold for the native-tab layout.
 *
 * Native tabs don't render a header, so content would slide under the status
 * bar / notch. This wraps content in a SafeAreaView applying top/left/right
 * insets (the tab bar owns the bottom inset) and an optional large title,
 * themed from the shared Cairn tokens.
 */
export function Screen({
  title,
  right,
  children,
  edges = ["top", "left", "right"],
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  edges?: ("top" | "bottom" | "left" | "right")[];
}) {
  const t = useTheme();
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: t.background }]} edges={edges}>
      {title ? (
        <View style={styles.header}>
          <Text style={[styles.title, { color: t.textPrimary }]}>{title}</Text>
          {right ? <View>{right}</View> : null}
        </View>
      ) : null}
      <View style={styles.body}>{children}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 6,
  },
  title: { fontSize: 30, fontWeight: "700" },
  body: { flex: 1 },
});
