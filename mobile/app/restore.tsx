import { useCallback, useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, Alert } from "react-native";
import { Stack, useRouter } from "expo-router";
import { RotateCcw, Trash2 } from "lucide-react-native";
import { listRestorableNotes, restoreDeletedNote } from "@/db/queries";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { useTheme, type as typeScale, type Theme, withAlpha } from "@/theme";

/**
 * Recovery screen for notes another device deleted (plan §4 Phase 4b).
 *
 * The list comes straight from the shared sync engine, which applies the same
 * rules as desktop: tombstone shells, conflict copies, orphaned notes and
 * deletes this device authored itself are all excluded, so every row here is
 * genuinely restorable. Restoring republishes the note with proof it observed
 * the deletion, which is why it converges instead of being deleted again on the
 * next sync.
 */

type RestorableRow = {
  entity_id: string;
  title: string | null;
  deleted_at: string | null;
  delete_origin: string | null;
};

/** Why a restore was refused, in words a user can act on. */
const REFUSAL_TEXT: Record<string, string> = {
  missing: "That note is no longer in the database.",
  live: "That note is already restored.",
  shell: "This device never received the note's content, so there's nothing to bring back.",
  "conflict-copy": "This is a conflict copy — resolve it from the Conflicts screen instead.",
  orphaned: "Its project was deleted too. Restore the project first.",
  "self-deleted": "This device deleted that note, so it isn't offered for recovery.",
};

function relativeTime(iso: string | null): string {
  if (!iso) return "recently";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "recently";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Device ids are opaque, so name the peer generically rather than showing one. */
function deviceLabel(origin: string | null): string {
  if (!origin) return "another device";
  if (/^desktop/i.test(origin)) return "your desktop";
  if (/^mobile|^ios|^android/i.test(origin)) return "another phone";
  return "another device";
}

export default function RestoreScreen() {
  const t = useTheme();
  const router = useRouter();
  const [rows, setRows] = useState<RestorableRow[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const styles = useMemo(() => makeStyles(t), [t]);

  const load = useCallback(() => {
    const res = listRestorableNotes(50);
    setRows(res.rows);
    setTotal(res.total);
  }, []);
  useRefreshOnFocus(load);

  const onRestore = (row: RestorableRow) => {
    setBusy(row.entity_id);
    try {
      const res = restoreDeletedNote(row.entity_id);
      if (res.restored) {
        load();
      } else {
        // Never fail silently — a recovery action that does nothing is
        // indistinguishable from a bug.
        Alert.alert("Couldn't restore", REFUSAL_TEXT[res.reason] ?? "That note can't be restored.");
        load();
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Deleted Notes", headerBackTitle: "Sync" }} />
      {rows.length === 0 ? (
        <View style={styles.empty}>
          <Trash2 size={40} color={t.textTertiary} />
          <Text style={styles.emptyTitle}>Nothing to restore</Text>
          <Text style={styles.emptyText}>
            If another device deletes a note, it shows up here so you can bring it back. Notes you
            delete yourself aren&apos;t listed.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.intro}>
            {total} note{total === 1 ? "" : "s"} deleted on another device. Restoring brings a note
            back everywhere — it won&apos;t be deleted again on the next sync.
          </Text>
          {rows.map((row) => (
            <View key={row.entity_id} style={styles.card}>
              <Pressable onPress={() => router.push(`/note/${row.entity_id}`)}>
                <Text style={styles.cardTitle} numberOfLines={2}>
                  {row.title || "Untitled"}
                </Text>
              </Pressable>
              <Text style={styles.meta}>
                deleted {relativeTime(row.deleted_at)} on {deviceLabel(row.delete_origin)}
              </Text>
              <View style={styles.actions}>
                <Pressable
                  style={[styles.btn, styles.btnPrimary, busy === row.entity_id && styles.btnDisabled]}
                  disabled={busy === row.entity_id}
                  onPress={() => onRestore(row)}
                >
                  <RotateCcw size={14} color={t.accentFg} />
                  <Text style={styles.btnPrimaryText}>Restore</Text>
                </Pressable>
              </View>
            </View>
          ))}
          {total > rows.length && (
            <Text style={styles.more}>
              Showing {rows.length} of {total}.
            </Text>
          )}
        </ScrollView>
      )}
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.background },
    scroll: { padding: 16, gap: 12 },
    intro: { ...typeScale.caption, color: t.textTertiary, lineHeight: 18 },
    card: {
      padding: 14,
      backgroundColor: t.surface2,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: withAlpha(t.danger, 0.35),
      gap: 6,
    },
    cardTitle: { ...typeScale.control, color: t.textPrimary },
    meta: { ...typeScale.caption, color: t.textTertiary },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 4 },
    btn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 14,
      paddingVertical: 9,
      borderRadius: 10,
    },
    btnPrimary: { backgroundColor: t.accent },
    btnPrimaryText: { ...typeScale.control, color: t.accentFg },
    btnDisabled: { opacity: 0.6 },
    more: { ...typeScale.caption, color: t.textTertiary, textAlign: "center" },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 10 },
    emptyTitle: { ...typeScale.title, color: t.textPrimary },
    emptyText: { ...typeScale.caption, color: t.textTertiary, textAlign: "center", lineHeight: 18 },
  });
}
