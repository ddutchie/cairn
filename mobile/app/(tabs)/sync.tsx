import { useCallback, useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { useFocusEffect } from "expo-router";
import { Screen } from "@/components/Screen";
import { connectSyncFolder, clearSyncFolder, getSyncFolderUri } from "@/sync/folder";
import { syncNow, pendingCount, type SyncResult } from "@/sync/sync";
import { useTheme, type Theme } from "@/theme";

function folderLabel(uri: string): string {
  try {
    const decoded = decodeURIComponent(uri.replace(/\/$/, ""));
    const parts = decoded.split("/").filter(Boolean);
    return parts[parts.length - 1] || decoded;
  } catch {
    return uri;
  }
}

export default function SyncScreen() {
  const t = useTheme();
  const [folderUri, setFolderUri] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<SyncResult | null>(null);
  const styles = useMemo(() => makeStyles(t), [t]);

  const refresh = useCallback(() => {
    setFolderUri(getSyncFolderUri());
    setPending(pendingCount());
  }, []);

  useFocusEffect(useCallback(() => refresh(), [refresh]));

  const onConnect = async () => {
    const dir = await connectSyncFolder();
    if (dir) refresh();
  };
  const onDisconnect = () => {
    clearSyncFolder();
    setLast(null);
    refresh();
  };
  const onSync = async () => {
    setBusy(true);
    try {
      await new Promise((r) => setTimeout(r, 0));
      const res = syncNow();
      setLast(res);
      if (!res.connected) Alert.alert("No folder connected", "Connect your iCloud Cairn folder first.");
      refresh();
    } catch (e) {
      Alert.alert("Sync failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const connected = !!folderUri;

  return (
    <Screen title="Sync">
      <View style={styles.container}>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>iCloud sync folder</Text>
          {connected ? (
            <>
              <View style={styles.statusRow}>
                <View style={[styles.dot, { backgroundColor: t.success }]} />
                <Text style={styles.folderName}>{folderLabel(folderUri!)}</Text>
              </View>
              <Pressable onPress={onDisconnect} hitSlop={8}>
                <Text style={styles.disconnect}>Disconnect</Text>
              </Pressable>
            </>
          ) : (
            <>
              <View style={styles.statusRow}>
                <View style={[styles.dot, { backgroundColor: t.textTertiary }]} />
                <Text style={styles.notConnected}>Not connected</Text>
              </View>
              <Pressable style={styles.button} onPress={onConnect}>
                <Text style={styles.buttonText}>Connect folder…</Text>
              </Pressable>
              <Text style={styles.help}>
                Pick the same folder your desktop syncs to (iCloud Drive → your Cairn sync folder).
              </Text>
            </>
          )}
        </View>

        {connected && (
          <>
            <Pressable style={[styles.syncButton, busy && styles.buttonDisabled]} onPress={onSync} disabled={busy}>
              {busy ? (
                <ActivityIndicator color={t.accentFg} />
              ) : (
                <Text style={styles.buttonText}>Sync now{pending > 0 ? ` (${pending} pending)` : ""}</Text>
              )}
            </Pressable>

            {last && last.connected && (
              <View style={styles.result}>
                <Text style={styles.resultLine}>Local changes sent: {last.drained}</Text>
                <Text style={styles.resultLine}>Peer changes applied: {last.peerOpsApplied}</Text>
                <Text style={styles.resultLine}>
                  Conflict copies: {last.conflictCopies}
                  {last.conflictCopies > 0 ? "  (see Notes)" : ""}
                </Text>
              </View>
            )}
          </>
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
    notConnected: { fontSize: 15, color: t.textSecondary },
    disconnect: { color: t.danger, fontSize: 13, marginTop: 12 },
    button: { backgroundColor: t.accent, paddingVertical: 12, borderRadius: 10, alignItems: "center", marginTop: 14 },
    syncButton: { backgroundColor: t.accent, paddingVertical: 14, borderRadius: 12, alignItems: "center", marginTop: 16 },
    buttonDisabled: { opacity: 0.6 },
    buttonText: { color: t.accentFg, fontWeight: "600", fontSize: 15 },
    help: { fontSize: 12, color: t.textTertiary, marginTop: 10, lineHeight: 18 },
    result: { marginTop: 16, padding: 14, backgroundColor: t.surface, borderRadius: 10, borderWidth: 1, borderColor: t.border },
    resultLine: { fontSize: 14, color: t.textPrimary, marginBottom: 4 },
    note: { marginTop: 24, fontSize: 12, color: t.textTertiary, lineHeight: 18 },
  });
}
