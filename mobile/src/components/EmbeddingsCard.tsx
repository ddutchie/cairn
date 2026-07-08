import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useFocusEffect } from "expo-router";
import { Sparkles } from "lucide-react-native";
import { listWorkspaceIds, embeddingIndexStats } from "@/db/queries";
import {
  isAppleEmbeddingsSupported,
  appleEmbeddingsUnavailableReason,
} from "@modules/apple-embeddings";
import { catchUpIndex } from "@/notes/embeddings";
import { useIndexStatus } from "@/notes/useIndexStatus";
import { useTheme, type as typeScale, type Theme } from "@/theme";

/**
 * On-device semantic-search index status + manual reindex, surfaced in the Sync
 * modal. Shows how many notes are indexed vs total and lets the user force a
 * catch-up pass (useful right after notes sync in from desktop). Renders an
 * "unavailable" explainer when on-device embeddings can't run (older iOS,
 * simulator, non-Apple build).
 */
export function EmbeddingsCard() {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const supported = isAppleEmbeddingsSupported();
  const status = useIndexStatus();
  const [stats, setStats] = useState<{ indexed: number; total: number } | null>(null);

  const refresh = useCallback(() => {
    let total = 0;
    let indexed = 0;
    for (const ws of listWorkspaceIds()) {
      const s = embeddingIndexStats(ws);
      total += s.liveNotes;
      indexed += s.indexedNotes;
    }
    setStats({ indexed, total });
  }, []);

  // Refresh on open and again whenever an indexing pass finishes (running
  // transitions true → false), so counts stay fresh even after an automatic
  // catch-up completes while this card is visible.
  useFocusEffect(useCallback(() => refresh(), [refresh]));
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !status.running) refresh();
    wasRunning.current = status.running;
  }, [status.running, refresh]);

  const onReindex = useCallback(() => {
    catchUpIndex()
      .then(refresh)
      .catch((e) => console.warn("[embeddings] reindex failed:", e));
  }, [refresh]);

  const busy = status.running;
  const behind = stats ? stats.total - stats.indexed : 0;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Sparkles size={16} color={t.accent} />
        <Text style={styles.cardLabel}>Semantic search index</Text>
      </View>

      {!supported ? (
        <Text style={styles.help}>{appleEmbeddingsUnavailableReason()}</Text>
      ) : (
        <>
          {busy ? (
            <View style={styles.statusRow}>
              <ActivityIndicator color={t.textTertiary} />
              <Text style={styles.progress}>
                {status.total > 0 ? `Indexing… ${status.done}/${status.total}` : "Preparing…"}
              </Text>
            </View>
          ) : (
            <Text style={styles.count}>
              {stats ? `${stats.indexed} of ${stats.total} notes indexed` : "—"}
            </Text>
          )}

          <Text style={styles.help}>
            {behind > 0
              ? `${behind} note${behind === 1 ? "" : "s"} not yet indexed (e.g. just synced from another device). Reindex to search them by meaning.`
              : "All notes are indexed. On-device embeddings power semantic search — your notes never leave the device."}
          </Text>

          <Pressable
            style={[styles.button, busy && styles.buttonDisabled]}
            onPress={onReindex}
            disabled={busy}
            accessibilityLabel="Reindex notes for semantic search"
          >
            <Text style={styles.buttonText}>{busy ? "Indexing…" : "Reindex now"}</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    card: { padding: 16, backgroundColor: t.surface, borderRadius: 12, borderWidth: 1, borderColor: t.border, marginTop: 16 },
    header: { flexDirection: "row", alignItems: "center", gap: 8 },
    cardLabel: { fontSize: 12, fontWeight: "600", color: t.textTertiary, textTransform: "uppercase", letterSpacing: 0.5 },
    statusRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
    progress: { ...typeScale.control, color: t.textSecondary },
    count: { ...typeScale.control, color: t.textPrimary, marginTop: 10 },
    help: { ...typeScale.caption, color: t.textTertiary, marginTop: 10, lineHeight: 18 },
    button: { backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border, paddingVertical: 12, borderRadius: 10, alignItems: "center", marginTop: 14 },
    buttonDisabled: { opacity: 0.6 },
    buttonText: { ...typeScale.control, color: t.accent },
  });
}
