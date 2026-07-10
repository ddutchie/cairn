import { useEffect, type ReactNode } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, ScrollView, Image } from "react-native";
import { useTheme, type Theme } from "@/theme";
import { setActiveSource } from "@/db";
import { useSyncSources } from "@/sync/useSyncSources";

// Same artwork as the launch splash / empty states, so the picker reads as
// "the app, waiting for a source" rather than a bare screen.
const CAIRN_ICON = require("../../assets/splashIcon.png");

/** A numbered setup step. */
function Step({ n, t, children }: { n: number; t: Theme; children: ReactNode }) {
  return (
    <View style={styles.step}>
      <View style={[styles.stepNum, { backgroundColor: t.accentDim }]}>
        <Text style={[styles.stepNumText, { color: t.accent }]}>{n}</Text>
      </View>
      <Text style={[styles.stepText, { color: t.textSecondary }]}>{children}</Text>
    </View>
  );
}

/**
 * Source picker shown when no sync source is selected. Scans the shared iCloud
 * folder for `oplog-<deviceId>-<workspaceId>.ndjson` files and lists the
 * distinct workspaces (sources) the desktops have published. Picking one opens
 * that source's dedicated DB (`cairn-mobile-<workspaceId>.db`) and re-scopes the
 * whole app via getDb()/getEngine().
 */
export function SourcePicker({ onSelected }: { onSelected: (workspaceId: string) => void }) {
  const t = useTheme();
  const { sources, loading, error, refresh } = useSyncSources({ gateOnICloud: true });

  useEffect(() => {
    // Defer to a microtask so the initial setState in refresh() doesn't run
    // synchronously inside the effect body (avoids cascading-render lint).
    const id = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(id);
  }, [refresh]);

  function pick(workspaceId: string) {
    setActiveSource(workspaceId);
    onSelected(workspaceId);
  }

  const hasSources = !loading && !error && sources.length > 0;

  return (
    <View style={[styles.container, { backgroundColor: t.background }]}>
      <View style={styles.brand}>
        <Image source={CAIRN_ICON} style={styles.icon} resizeMode="contain" />
        <Text style={[styles.title, { color: t.textPrimary }]}>
          {hasSources ? "Choose a workspace" : "Connect a workspace"}
        </Text>
        <Text style={[styles.subtitle, { color: t.textTertiary }]}>
          {hasSources
            ? "Open one of the workspaces your computers have published to iCloud."
            : "Cairn syncs through iCloud. Connect your Mac or PC to publish a workspace here."}
        </Text>
      </View>

      <View style={styles.body}>
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
          <View style={styles.steps}>
            <Step n={1} t={t}>Open Cairn on your Mac or PC.</Step>
            <Step n={2} t={t}>Go to Settings → Device Sync → Connect folder.</Step>
            <Step n={3} t={t}>
              Choose{" "}
              <Text style={{ color: t.textPrimary, fontWeight: "600" }}>iCloud Drive → Cairn → sync</Text>.
            </Step>
            <Step n={4} t={t}>Give iCloud a moment, then Refresh.</Step>
          </View>
        ) : (
          <ScrollView>
            {sources.map((s) => (
              <TouchableOpacity
                key={s.workspaceId}
                style={[styles.item, { backgroundColor: t.surface, borderColor: t.border }]}
                onPress={() => pick(s.workspaceId)}
              >
                <Text style={[styles.itemTitle, { color: t.textPrimary }]}>
                  {s.name ?? "Workspace"}
                </Text>
                <Text style={[styles.itemId, { color: t.textTertiary }]}>{s.workspaceId}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>

      <TouchableOpacity
        style={[styles.refresh, { borderColor: t.border }]}
        onPress={() => void refresh()}
        disabled={loading}
      >
        <Text style={[styles.refreshText, { color: loading ? t.textTertiary : t.accent }]}>Refresh</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, paddingTop: 72 },
  brand: { alignItems: "center" },
  icon: { width: 76, height: 76, marginBottom: 12 },
  title: { fontSize: 24, fontWeight: "700" },
  subtitle: { fontSize: 14, marginTop: 8, lineHeight: 20, textAlign: "center", maxWidth: 320 },
  body: { flex: 1, justifyContent: "center", marginTop: 24 },
  center: { alignItems: "center", padding: 24 },
  hint: { marginTop: 12, textAlign: "center", lineHeight: 20 },
  steps: { gap: 16, paddingHorizontal: 4 },
  step: { flexDirection: "row", alignItems: "center", gap: 12 },
  stepNum: { width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  stepNumText: { fontSize: 13, fontWeight: "700" },
  stepText: { flex: 1, fontSize: 15, lineHeight: 21 },
  item: { padding: 16, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, marginBottom: 12 },
  itemTitle: { fontSize: 16, fontWeight: "600" },
  itemId: { fontSize: 12, marginTop: 4, fontFamily: "Courier" },
  refresh: { alignSelf: "center", paddingVertical: 12, paddingHorizontal: 24, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, marginTop: 8 },
  refreshText: { fontSize: 15, fontWeight: "600" },
});
