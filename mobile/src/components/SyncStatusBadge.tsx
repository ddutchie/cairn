import { Pressable, Text, ActivityIndicator, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { Cloud, CloudOff, RefreshCw } from "lucide-react-native";
import { useTheme } from "@/theme";
import { useSyncStatus } from "@/sync/useSyncStatus";

/**
 * Compact global sync-status button for screen headers. Reflects the auto-sync
 * controller's live state (idle / syncing / offline + pending count) and, on
 * tap, opens the Sync detail page (folder diagnostics, manual sync, conflict
 * resolution). Its icon/colour escalate when offline or when changes are
 * pending, drawing the eye when there's something to act on.
 */
export function SyncStatusBadge() {
  const t = useTheme();
  const router = useRouter();
  const { state, pending } = useSyncStatus();

  const color = state === "offline" ? t.textTertiary : pending > 0 ? t.warning : t.success;

  return (
    <Pressable
      onPress={() => router.push("/sync")}
      hitSlop={8}
      style={styles.pill}
    >
      {state === "syncing" ? (
        <ActivityIndicator size="small" color={t.accent} />
      ) : state === "offline" ? (
        <CloudOff size={20} color={color} />
      ) : pending > 0 ? (
        <RefreshCw size={20} color={color} />
      ) : (
        <Cloud size={20} color={color} />
      )}
      {pending > 0 && state !== "syncing" ? <Text style={[styles.count, { color }]}>{pending}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  count: { fontSize: 12, fontWeight: "700" },
});
