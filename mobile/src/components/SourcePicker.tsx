import { useCallback, useEffect, useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, ScrollView } from "react-native";
import { useTheme } from "@/theme";
import { setActiveSource, getDeviceId } from "@/db";
import { getSyncFolderPath, iCloudAvailable } from "@/sync/folder";
import { listSources } from "@/sync/fs-transport";

/**
 * Source picker shown when no sync source is selected. Scans the shared iCloud
 * folder for `oplog-<deviceId>-<workspaceId>.ndjson` files and lists the
 * distinct workspaces (sources) the desktops have published. Picking one opens
 * that source's dedicated DB (`cairn-mobile-<workspaceId>.db`) and re-scopes the
 * whole app via getDb()/getEngine().
 */
export function SourcePicker({ onSelected }: { onSelected: (workspaceId: string) => void }) {
  const t = useTheme();
  const [loading, setLoading] = useState(true);
  const [sources, setSources] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!(await iCloudAvailable())) {
        setError("iCloud isn't available. Sign in to iCloud in Settings, then reopen Cairn.");
        setSources([]);
        return;
      }
      const folder = await getSyncFolderPath();
      if (!folder) {
        setError("Couldn't open the iCloud Cairn folder.");
        setSources([]);
        return;
      }
      const found = await listSources(folder, getDeviceId());
      setSources(found);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Defer to a microtask so the initial setState in scan() doesn't run
    // synchronously inside the effect body (avoids cascading-render lint).
    const id = setTimeout(() => void scan(), 0);
    return () => clearTimeout(id);
  }, [scan]);

  function pick(workspaceId: string) {
    setActiveSource(workspaceId);
    onSelected(workspaceId);
  }

  return (
    <View style={[styles.container, { backgroundColor: t.background }]}>
      <Text style={[styles.title, { color: t.textPrimary }]}>Choose a source</Text>
      <Text style={[styles.subtitle, { color: t.textTertiary }]}>
        Point your Mac and PC at the same iCloud Cairn folder. Each one appears here as a
        source you can sync.
      </Text>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={t.accent} />
          <Text style={[styles.hint, { color: t.textTertiary }]}>Scanning iCloud…</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={[styles.hint, { color: t.danger }]}>{error}</Text>
        </View>
      ) : sources.length === 0 ? (
        <View style={styles.center}>
          <Text style={[styles.hint, { color: t.textTertiary }]}>
            No sources found yet. Open Cairn on your Mac or PC, connect it to the same
            iCloud folder, then refresh.
          </Text>
        </View>
      ) : (
        <ScrollView style={styles.list}>
          {sources.map((ws) => (
            <TouchableOpacity
              key={ws}
              style={[styles.item, { backgroundColor: t.surface, borderColor: t.border }]}
              onPress={() => pick(ws)}
            >
              <Text style={[styles.itemTitle, { color: t.textPrimary }]}>Workspace</Text>
              <Text style={[styles.itemId, { color: t.textTertiary }]}>{ws}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      <TouchableOpacity style={[styles.refresh, { borderColor: t.border }]} onPress={() => void scan()}>
        <Text style={[styles.refreshText, { color: t.accent }]}>Refresh</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, paddingTop: 80 },
  title: { fontSize: 24, fontWeight: "700" },
  subtitle: { fontSize: 14, marginTop: 8, lineHeight: 20 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  hint: { marginTop: 12, textAlign: "center", lineHeight: 20 },
  list: { flex: 1, marginTop: 24 },
  item: { padding: 16, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, marginBottom: 12 },
  itemTitle: { fontSize: 16, fontWeight: "600" },
  itemId: { fontSize: 12, marginTop: 4, fontFamily: "Courier" },
  refresh: { alignSelf: "center", paddingVertical: 12, paddingHorizontal: 24, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, marginTop: 16 },
  refreshText: { fontSize: 15, fontWeight: "600" },
});
