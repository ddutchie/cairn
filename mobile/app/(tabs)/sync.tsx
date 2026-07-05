import { useCallback, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { useFocusEffect } from "expo-router";
import { Screen } from "@/components/Screen";
import { connectSyncFolder, clearSyncFolder, getSyncFolderUri } from "@/sync/folder";
import { syncNow, pendingCount, type SyncResult } from "@/sync/sync";

/** Show the trailing path component of a file:// URI for a friendlier label. */
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
  const [folderUri, setFolderUri] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<SyncResult | null>(null);

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
      // Yield a frame so the spinner renders before the synchronous engine work.
      await new Promise((r) => setTimeout(r, 0));
      const res = syncNow();
      setLast(res);
      if (!res.connected) {
        Alert.alert("No folder connected", "Connect your iCloud Cairn folder first.");
      }
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
        {/* Connection card */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>iCloud sync folder</Text>
          {connected ? (
            <>
              <View style={styles.statusRow}>
                <View style={styles.dotConnected} />
                <Text style={styles.folderName}>{folderLabel(folderUri!)}</Text>
              </View>
              <Pressable onPress={onDisconnect} hitSlop={8}>
                <Text style={styles.disconnect}>Disconnect</Text>
              </Pressable>
            </>
          ) : (
            <>
              <View style={styles.statusRow}>
                <View style={styles.dotIdle} />
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

        {/* Sync action */}
        {connected ? (
          <>
            <Pressable style={[styles.syncButton, busy && styles.buttonDisabled]} onPress={onSync} disabled={busy}>
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>
                  Sync now{pending > 0 ? ` (${pending} pending)` : ""}
                </Text>
              )}
            </Pressable>

            {last && last.connected ? (
              <View style={styles.result}>
                <Text style={styles.resultLine}>Local changes sent: {last.drained}</Text>
                <Text style={styles.resultLine}>Peer changes applied: {last.peerOpsApplied}</Text>
                <Text style={styles.resultLine}>
                  Conflict copies: {last.conflictCopies}
                  {last.conflictCopies > 0 ? "  (see Notes)" : ""}
                </Text>
              </View>
            ) : null}
          </>
        ) : null}

        <Text style={styles.note}>
          Bidirectional, offline-first. Edits made on this phone and the desktop reconcile via the
          shared sync engine — the same engine the desktop runs. Body conflicts are kept as a
          &quot;conflicted copy&quot; note, never silently lost.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  card: { padding: 16, backgroundColor: "#fff", borderRadius: 12, borderWidth: 1, borderColor: "#eee" },
  cardLabel: { fontSize: 12, fontWeight: "600", color: "#999", textTransform: "uppercase", letterSpacing: 0.5 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  dotConnected: { width: 9, height: 9, borderRadius: 5, backgroundColor: "#22c55e" },
  dotIdle: { width: 9, height: 9, borderRadius: 5, backgroundColor: "#cbd5e1" },
  folderName: { fontSize: 15, fontWeight: "600", color: "#111", flex: 1 },
  notConnected: { fontSize: 15, color: "#666" },
  disconnect: { color: "#ef4444", fontSize: 13, marginTop: 12 },
  button: { backgroundColor: "#6366f1", paddingVertical: 12, borderRadius: 10, alignItems: "center", marginTop: 14 },
  syncButton: { backgroundColor: "#6366f1", paddingVertical: 14, borderRadius: 12, alignItems: "center", marginTop: 16 },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  help: { fontSize: 12, color: "#999", marginTop: 10, lineHeight: 18 },
  result: { marginTop: 16, padding: 14, backgroundColor: "#fff", borderRadius: 10, borderWidth: 1, borderColor: "#eee" },
  resultLine: { fontSize: 14, color: "#333", marginBottom: 4 },
  note: { marginTop: 24, fontSize: 12, color: "#999", lineHeight: 18 },
});
