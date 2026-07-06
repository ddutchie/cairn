import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View, ActivityIndicator, StyleSheet } from "react-native";
import { Cloud, CloudOff, RefreshCw } from "lucide-react-native";
import { useTheme } from "@/theme";
import { syncNow, pendingCount } from "@/sync/sync";

/**
 * Compact global sync-status pill for screen headers: shows pending-change
 * count and current state (idle / syncing / offline), and triggers a sync on
 * tap. Polls pendingCount lightly while mounted.
 */
export function SyncStatusBadge() {
  const t = useTheme();
  const [pending, setPending] = useState(0);
  const [state, setState] = useState<"idle" | "syncing" | "offline">("idle");

  const refresh = useCallback(() => {
    try {
      setPending(pendingCount());
    } catch {
      /* db not ready */
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh]);

  const onPress = async () => {
    if (state === "syncing") return;
    setState("syncing");
    try {
      const res = await syncNow();
      setState(res.connected ? "idle" : "offline");
    } catch {
      setState("offline");
    } finally {
      refresh();
    }
  };

  const color = state === "offline" ? t.textTertiary : pending > 0 ? t.warning : t.success;

  return (
    <Pressable onPress={onPress} hitSlop={8} style={[styles.pill, { backgroundColor: t.surface2, borderColor: t.border }]}>
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
