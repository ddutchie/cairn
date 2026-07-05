import type { ReactNode } from "react";
import { StyleSheet, View, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

/**
 * Shared screen scaffold for the native-tab layout.
 *
 * Native tabs (expo-router/unstable-native-tabs) don't render a header bar, so
 * screen content would otherwise slide under the status bar / notch. This wraps
 * content in a SafeAreaView that applies the top/left/right insets (the tab bar
 * handles the bottom inset itself) and renders an optional large title.
 */
export function Screen({
  title,
  children,
  edges = ["top", "left", "right"],
  style,
}: {
  title?: string;
  children: ReactNode;
  edges?: ("top" | "bottom" | "left" | "right")[];
  style?: object;
}) {
  return (
    <SafeAreaView style={[styles.safe, style]} edges={edges}>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      <View style={styles.body}>{children}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f8f8f8" },
  title: {
    fontSize: 30,
    fontWeight: "700",
    color: "#111",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  body: { flex: 1 },
});
