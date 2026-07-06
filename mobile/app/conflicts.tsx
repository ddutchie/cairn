import { useCallback, useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, Alert } from "react-native";
import { Stack, useRouter, useFocusEffect } from "expo-router";
import { GitMerge } from "lucide-react-native";
import {
  listConflictCopies,
  resolveConflictKeepCopy,
  resolveConflictKeepOriginal,
  type ConflictCopy,
} from "@/db/queries";
import { useDataChanged } from "@/sync/useSyncStatus";
import { useTheme, type Theme } from "@/theme";

/**
 * Manual conflict-resolution screen. Lists every conflict-copy note (created
 * when the same note body diverged on two devices while offline) side-by-side
 * with its original, and lets the user keep either version. Never silent loss.
 */
export default function ConflictsScreen() {
  const t = useTheme();
  const router = useRouter();
  const [conflicts, setConflicts] = useState<ConflictCopy[]>([]);
  const styles = useMemo(() => makeStyles(t), [t]);

  const load = useCallback(() => setConflicts(listConflictCopies()), []);
  useFocusEffect(useCallback(() => load(), [load]));
  useDataChanged(load);

  const keepCopy = (c: ConflictCopy) => {
    resolveConflictKeepCopy(c.id);
    load();
  };
  const keepOriginal = (c: ConflictCopy) => {
    Alert.alert("Discard this copy?", "The original note is kept and this conflicted copy is deleted.", [
      { text: "Cancel", style: "cancel" },
      { text: "Discard copy", style: "destructive", onPress: () => { resolveConflictKeepOriginal(c.id); load(); } },
    ]);
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Sync Conflicts", headerBackTitle: "Sync" }} />
      {conflicts.length === 0 ? (
        <View style={styles.empty}>
          <GitMerge size={40} color={t.textTertiary} />
          <Text style={styles.emptyTitle}>No conflicts</Text>
          <Text style={styles.emptyText}>
            When the same note is edited on two devices while offline, both versions are kept here so nothing is lost.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.intro}>
            {conflicts.length} note{conflicts.length === 1 ? "" : "s"} diverged. Choose which version to keep — the other is discarded.
          </Text>
          {conflicts.map((c) => (
            <View key={c.id} style={styles.card}>
              <Pressable onPress={() => router.push(`/note/${c.id}`)}>
                <Text style={styles.cardTitle} numberOfLines={2}>{c.title}</Text>
              </Pressable>
              {c.deviceId ? <Text style={styles.meta}>Copy from {c.deviceId}</Text> : null}

              <View style={styles.versions}>
                <VersionBlock
                  label="This device (original)"
                  body={c.original?.content ?? "(original was deleted)"}
                  onOpen={c.original ? () => router.push(`/note/${c.original!.id}`) : undefined}
                  t={t}
                  styles={styles}
                />
                <VersionBlock
                  label="Conflicted copy"
                  body={c.content ?? ""}
                  onOpen={() => router.push(`/note/${c.id}`)}
                  t={t}
                  styles={styles}
                />
              </View>

              <View style={styles.actions}>
                <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => keepOriginal(c)}>
                  <Text style={styles.btnGhostText}>Keep original</Text>
                </Pressable>
                <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => keepCopy(c)}>
                  <Text style={styles.btnPrimaryText}>Keep this copy</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function VersionBlock({
  label,
  body,
  onOpen,
  t,
  styles,
}: {
  label: string;
  body: string;
  onOpen?: () => void;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
}) {
  const preview = body.replace(/\s+/g, " ").trim().slice(0, 240);
  return (
    <Pressable style={styles.version} onPress={onOpen} disabled={!onOpen}>
      <Text style={styles.versionLabel}>{label}</Text>
      <Text style={styles.versionBody} numberOfLines={5}>
        {preview || "(empty)"}
      </Text>
    </Pressable>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.background },
    scroll: { padding: 16, paddingBottom: 48 },
    intro: { fontSize: 13, color: t.textSecondary, marginBottom: 14, lineHeight: 19 },
    card: { backgroundColor: t.surface, borderRadius: 14, borderWidth: 1, borderColor: t.border, padding: 14, marginBottom: 16 },
    cardTitle: { fontSize: 17, fontWeight: "700", color: t.textPrimary },
    meta: { fontSize: 12, color: t.textTertiary, marginTop: 4 },
    versions: { gap: 10, marginTop: 12 },
    version: { backgroundColor: t.surface2, borderRadius: 10, borderWidth: 1, borderColor: t.borderSubtle, padding: 10 },
    versionLabel: { fontSize: 11, fontWeight: "700", color: t.textTertiary, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 },
    versionBody: { fontSize: 13, color: t.textPrimary, lineHeight: 19 },
    actions: { flexDirection: "row", gap: 10, marginTop: 14 },
    btn: { flex: 1, paddingVertical: 11, borderRadius: 10, alignItems: "center" },
    btnGhost: { backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border },
    btnGhostText: { color: t.textSecondary, fontWeight: "600", fontSize: 14 },
    btnPrimary: { backgroundColor: t.accent },
    btnPrimaryText: { color: t.accentFg, fontWeight: "700", fontSize: 14 },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40, gap: 12 },
    emptyTitle: { fontSize: 18, fontWeight: "700", color: t.textPrimary },
    emptyText: { fontSize: 13, color: t.textTertiary, textAlign: "center", lineHeight: 19 },
  });
}
