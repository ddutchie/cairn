import { useCallback, useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { GitMerge, ChevronRight } from "lucide-react-native";
import { Screen } from "@/components/Screen";
import { iCloudAvailable, syncFolderLabel } from "@/sync/folder";
import { requestSync } from "@/sync/controller";
import { useSyncStatus } from "@/sync/useSyncStatus";
import { useTheme, type Theme } from "@/theme";

export default function SyncScreen() {
  const t = useTheme();
  const router = useRouter();
  const { state, pending, conflicts, lastResult: last } = useSyncStatus();
  const [available, setAvailable] = useState<boolean | null>(null);
  const styles = useMemo(() => makeStyles(t), [t]);
  const busy = state === "syncing";

  const refresh = useCallback(() => {
    iCloudAvailable().then(setAvailable).catch(() => setAvailable(false));
  }, []);

  useFocusEffect(useCallback(() => refresh(), [refresh]));

  const onSync = () => void requestSync("manual");

  return (
    <Screen title="Sync">
      <View style={styles.container}>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>iCloud sync folder</Text>
          <View style={styles.statusRow}>
            <View style={[styles.dot, { backgroundColor: available ? t.success : t.textTertiary }]} />
            <Text style={styles.folderName}>{syncFolderLabel()}</Text>
          </View>
          <Text style={styles.help}>
            {available === false
              ? "iCloud isn't available. Sign in to iCloud and enable iCloud Drive in iOS Settings."
              : "Automatic — this folder is your app's iCloud storage, shared with the desktop. No setup needed."}
          </Text>
        </View>

        <Pressable style={[styles.syncButton, busy && styles.buttonDisabled]} onPress={onSync} disabled={busy}>
          {busy ? (
            <ActivityIndicator color={t.accentFg} />
          ) : (
            <Text style={styles.buttonText}>Sync now{pending > 0 ? ` (${pending} pending)` : ""}</Text>
          )}
        </Pressable>

        <Text style={styles.autoNote}>
          {state === "offline" && last && !last.connected && last.reason
            ? last.reason
            : "Auto-sync is on — Cairn syncs on launch, when you switch back to the app, periodically, and shortly after you make a change. Use this button to sync immediately."}
        </Text>

        {last && last.connected && (
          <View style={styles.result}>
            <Text style={styles.resultLine}>Local changes sent: {last.drained}</Text>
            <Text style={styles.resultLine}>Peer changes applied: {last.peerOpsApplied}</Text>
            <Text style={styles.resultLine}>
              Conflict copies: {last.conflictCopies}
              {last.conflictCopies > 0 ? "  (tap below to resolve)" : ""}
            </Text>
          </View>
        )}

        {(conflicts > 0 || (last && last.connected)) && (
          <Pressable style={[styles.conflictRow, conflicts > 0 && styles.conflictRowActive]} onPress={() => router.push("/conflicts")}>
            <GitMerge size={18} color={conflicts > 0 ? t.warning : t.textTertiary} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.conflictTitle, conflicts > 0 && { color: t.textPrimary }]}>
                {conflicts > 0 ? `${conflicts} conflict${conflicts === 1 ? "" : "s"} to review` : "No conflicts"}
              </Text>
              <Text style={styles.conflictHelp}>
                {conflicts > 0 ? "Two devices edited the same note. Tap to resolve." : "Diverged notes appear here — nothing is ever lost."}
              </Text>
            </View>
            <ChevronRight size={18} color={t.textTertiary} />
          </Pressable>
        )}

        <Text style={styles.note}>
          Bidirectional, offline-first. Edits made on this phone and the desktop reconcile via the
          shared sync engine. Body conflicts are kept as a &quot;conflicted copy&quot; note, never lost.
        </Text>
      </View>
    </Screen>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1, padding: 20 },
    card: { padding: 16, backgroundColor: t.surface, borderRadius: 12, borderWidth: 1, borderColor: t.border },
    cardLabel: { fontSize: 12, fontWeight: "600", color: t.textTertiary, textTransform: "uppercase", letterSpacing: 0.5 },
    statusRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
    dot: { width: 9, height: 9, borderRadius: 5 },
    folderName: { fontSize: 15, fontWeight: "600", color: t.textPrimary, flex: 1 },
    help: { fontSize: 12, color: t.textTertiary, marginTop: 10, lineHeight: 18 },
    syncButton: { backgroundColor: t.accent, paddingVertical: 14, borderRadius: 12, alignItems: "center", marginTop: 16 },
    buttonDisabled: { opacity: 0.6 },
    buttonText: { color: t.accentFg, fontWeight: "600", fontSize: 15 },
    autoNote: { marginTop: 10, fontSize: 12, color: t.textTertiary, lineHeight: 17 },
    result: { marginTop: 16, padding: 14, backgroundColor: t.surface, borderRadius: 10, borderWidth: 1, borderColor: t.border },
    resultLine: { fontSize: 14, color: t.textPrimary, marginBottom: 4 },
    conflictRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 16, padding: 14, backgroundColor: t.surface, borderRadius: 12, borderWidth: 1, borderColor: t.border },
    conflictRowActive: { borderColor: t.warning, backgroundColor: t.surface2 },
    conflictTitle: { fontSize: 15, fontWeight: "600", color: t.textSecondary },
    conflictHelp: { fontSize: 12, color: t.textTertiary, marginTop: 2, lineHeight: 16 },
    note: { marginTop: 24, fontSize: 12, color: t.textTertiary, lineHeight: 18 },
  });
}
