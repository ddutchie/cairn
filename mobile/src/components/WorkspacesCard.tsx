import { useCallback, useMemo, useRef, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import ReanimatedSwipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { Trash2 } from "lucide-react-native";
import { getActiveSource } from "@/db";
import { pendingCountFor } from "@/sync/sync";
import { removeSource } from "@/sync/controller";
import { useSyncSources } from "@/sync/useSyncSources";
import { haptics } from "@/haptics";
import { SectionLabel } from "@/components/SectionLabel";
import { useTheme, type as typeScale, type Theme } from "@/theme";

interface Row {
  workspaceId: string;
  name: string | null;
}

/**
 * Workspaces on this phone, with swipe-to-delete. Deleting removes the
 * workspace's oplog files for EVERY device from the shared iCloud folder (and
 * the local copy). A desktop that is still connected rewrites its oplog on its
 * next sync, which brings the workspace back — so this is both "get rid of a
 * workspace the desktop dropped" and "re-sync it from scratch".
 */
export function WorkspacesCard({ removedFromFolder }: { removedFromFolder: boolean }) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const { sources, refresh } = useSyncSources({ mergeActive: true });
  const [busy, setBusy] = useState<string | null>(null);
  const active = getActiveSource();
  // Each row's swipeable, so a cancelled delete can slide the row shut again.
  const swipeables = useRef(new Map<string, SwipeableMethods>());

  useFocusEffect(useCallback(() => void refresh(), [refresh]));

  const confirmRemove = (row: Row) => {
    const close = () => swipeables.current.get(row.workspaceId)?.close();
    const label = row.name ?? "this workspace";
    if (busy) return; // one removal at a time
    const unsynced = pendingCountFor(row.workspaceId);
    const fallback = sources.find((s) => s.workspaceId !== row.workspaceId)?.workspaceId;
    haptics.warning();
    Alert.alert(
      `Delete “${label}”?`,
      "This removes the workspace's sync files from iCloud (for every device) and deletes this phone's copy. " +
        "If your computer is still connected to the same folder it will upload the workspace again and it will come back." +
        (unsynced > 0 ? `\n\n${unsynced} change${unsynced === 1 ? "" : "s"} on this phone haven't synced yet and will be lost.` : ""),
      [
        { text: "Cancel", style: "cancel", onPress: close },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            setBusy(row.workspaceId);
            removeSource(row.workspaceId, fallback)
              .then(() => refresh())
              .catch((e) => {
                close();
                Alert.alert("Couldn't delete workspace", e instanceof Error ? e.message : String(e));
              })
              .finally(() => setBusy(null));
          },
        },
      ],
    );
  };

  if (sources.length === 0) return null;

  return (
    <View style={styles.card}>
      <SectionLabel>Workspaces on this phone</SectionLabel>
      {removedFromFolder && (
        <Text style={[styles.warn, { color: t.warning }]}>
          The current workspace was removed from the sync folder, so syncing is paused. Swipe it left to delete it from
          this phone, or reconnect your computer to the same folder to bring it back.
        </Text>
      )}
      {sources.map((s) => (
        <ReanimatedSwipeable
          key={s.workspaceId}
          ref={(m) => {
            if (m) swipeables.current.set(s.workspaceId, m);
            else swipeables.current.delete(s.workspaceId);
          }}
          friction={2}
          rightThreshold={40}
          overshootRight={false}
          renderRightActions={() => (
            <View style={[styles.action, { backgroundColor: t.danger }]}>
              <Trash2 size={18} color={t.dangerFg} />
            </View>
          )}
          onSwipeableOpen={() => confirmRemove(s)}
        >
          <View
            style={[styles.row, { backgroundColor: t.surface2 }, busy === s.workspaceId && { opacity: 0.5 }]}
            accessibilityActions={[{ name: "delete", label: "Delete workspace" }]}
            onAccessibilityAction={() => confirmRemove(s)}
          >
            <Text style={styles.name} numberOfLines={1}>
              {s.name ?? "Workspace"}
            </Text>
            {s.workspaceId === active && <Text style={styles.badge}>Active</Text>}
          </View>
        </ReanimatedSwipeable>
      ))}
      <Text style={styles.help}>Swipe left on a workspace to delete it.</Text>
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    card: { marginTop: 16, padding: 16, backgroundColor: t.surface2, borderRadius: 12, borderWidth: 1, borderColor: t.border },
    warn: { ...typeScale.caption, marginTop: 10, lineHeight: 17 },
    row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 12, marginTop: 4 },
    name: { ...typeScale.control, color: t.textPrimary, flex: 1 },
    badge: { ...typeScale.caption, color: t.textTertiary },
    action: { justifyContent: "center", alignItems: "center", width: 72, marginTop: 4 },
    help: { ...typeScale.caption, color: t.textTertiary, marginTop: 10 },
  });
}
