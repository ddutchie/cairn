import type { ReactNode } from "react";
import { View, StyleSheet } from "react-native";
import { useTheme } from "@/theme";
import { ConflictBanner } from "./ConflictBanner";

/**
 * Body wrapper for a tab screen that lives UNDER a native Stack header.
 *
 * Replaces the old hand-rolled `Screen` scaffold: the title + top inset are now
 * owned by the native header (see TabStack + each screen's Stack.Screen
 * options), so this only provides the themed background and keeps the global
 * ConflictBanner visible on every tab.
 *
 * `bannerTopInset` is the header height for screens that run under a transparent header, so the
 * conflict banner is not hidden behind it.
 *
 * Set `scrollUnderLargeTitle` when the screen's own scroll view uses
 * `contentInsetAdjustmentBehavior="automatic"` — the banner then sits above the
 * scroll area rather than inside it.
 */
export function TabScreen({ children, bannerTopInset = 0 }: { children: ReactNode; bannerTopInset?: number }) {
  const t = useTheme();
  return (
    <View style={[styles.root, { backgroundColor: t.background }]}>
      <ConflictBanner topInset={bannerTopInset} />
      <View style={styles.body}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1 },
});
