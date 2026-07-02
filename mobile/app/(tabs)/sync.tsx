import { useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { importOplogFiles, type SyncInResult } from "@/sync/sync-in";

export default function SyncScreen() {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<SyncInResult | null>(null);

  const onImport = async () => {
    setBusy(true);
    try {
      const res = await importOplogFiles();
      setLast(res);
    } catch (e) {
      Alert.alert("Import failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Pull from desktop</Text>
      <Text style={styles.body}>
        Read-only sync (P3). Pick your desktop&apos;s{" "}
        <Text style={styles.mono}>oplog-*.ndjson</Text> file(s) from the synced folder. The shared
        sync engine reconciles them into this device — the same engine the desktop uses.
      </Text>

      <Pressable style={[styles.button, busy && styles.buttonDisabled]} onPress={onImport} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Import oplog files…</Text>}
      </Pressable>

      {last ? (
        <View style={styles.result}>
          <Text style={styles.resultLine}>Files imported: {last.filesImported}</Text>
          <Text style={styles.resultLine}>Ops applied: {last.opsApplied}</Text>
          <Text style={styles.resultLine}>Conflict copies: {last.conflictCopies}</Text>
        </View>
      ) : null}

      <Text style={styles.note}>
        Bidirectional sync and automatic folder access arrive in P4.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f8f8f8", padding: 20 },
  heading: { fontSize: 20, fontWeight: "700", color: "#111", marginBottom: 8 },
  body: { fontSize: 14, lineHeight: 21, color: "#555", marginBottom: 20 },
  mono: { fontFamily: "Menlo", fontSize: 13 },
  button: { backgroundColor: "#6366f1", paddingVertical: 14, borderRadius: 12, alignItems: "center" },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  result: { marginTop: 20, padding: 14, backgroundColor: "#fff", borderRadius: 10, borderWidth: 1, borderColor: "#eee" },
  resultLine: { fontSize: 14, color: "#333", marginBottom: 4 },
  note: { marginTop: 24, fontSize: 12, color: "#999" },
});
