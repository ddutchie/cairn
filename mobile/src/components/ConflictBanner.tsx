import { Pressable, Text, StyleSheet } from "react-native";
import { useMemo } from "react";
import { useRouter } from "expo-router";
import { AlertTriangle, ChevronRight } from "lucide-react-native";
import { useTheme, withAlpha, type as typeScale, type Theme } from "@/theme";
import { useSyncStatus } from "@/sync/useSyncStatus";

/**
 * Global banner surfaced whenever unresolved sync conflicts exist. Tapping it
 * opens the conflict-resolution screen. Driven by the auto-sync controller so
 * it appears automatically after a background sync creates conflict copies.
 */
export function ConflictBanner() {
  const t = useTheme();
  const router = useRouter();
  const { conflicts } = useSyncStatus();
  const styles = useMemo(() => makeStyles(t), [t]);
  if (conflicts <= 0) return null;
  return (
    <Pressable style={styles.banner} onPress={() => router.push("/conflicts")}>
      <AlertTriangle size={16} color={t.warning} />
      <Text style={styles.text}>
        {conflicts} sync conflict{conflicts === 1 ? "" : "s"} to review
      </Text>
      <ChevronRight size={16} color={t.warning} />
    </Pressable>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    banner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginHorizontal: 12,
      marginBottom: 6,
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderRadius: 10,
      backgroundColor: withAlpha(t.warning, 0.12),
      borderWidth: 1,
      borderColor: withAlpha(t.warning, 0.4),
    },
    text: { flex: 1, ...typeScale.label, color: t.textPrimary },
  });
}
