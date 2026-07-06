import { Pressable, Text, ActivityIndicator, StyleSheet } from "react-native";
import { Cloud, CloudOff, RefreshCw } from "lucide-react-native";
import { useTheme } from "@/theme";
import { useSyncStatus } from "@/sync/useSyncStatus";
import { requestSync } from "@/sync/controller";

/**
 * Compact global sync-status pill for screen headers. Reflects the auto-sync
 * controller's live state (idle / syncing / offline + pending count) and lets
 * the user force a sync on tap. Auto-sync runs on its own schedule; this is the
 * manual override + status readout.
 */
export function SyncStatusBadge() {
  const t = useTheme();
  const { state, pending } = useSyncStatus();

  const color = state === "offline" ? t.textTertiary : pending > 0 ? t.warning : t.success;

  return (
    <Pressable
      onPress={() => void requestSync("manual")}
      hitSlop={8}
      style={[styles.pill, { backgroundColor: t.surface2, borderColor: t.border }]}
    >
      {state === "syncing" ? (
        <ActivityIndicator size="small" color={t.accent} />
      ) : state === "offline" ? (
        <CloudOff size={14} color={color} />
      ) : pending > 0 ? (
        <RefreshCw size={14} color={color} />
      ) : (
        <Cloud size={14} color={color} />
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
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
  },
  count: { fontSize: 12, fontWeight: "700" },
});
