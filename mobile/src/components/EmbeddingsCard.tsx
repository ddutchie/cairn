import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useFocusEffect } from "expo-router";
import { Sparkles, Info } from "lucide-react-native";
import {
  listWorkspaceIds,
  embeddingIndexStats,
  listUnindexedNotes,
  type UnindexedNote,
} from "@/db/queries";
import {
  isAppleEmbeddingsSupported,
  appleEmbeddingsUnavailableReason,
} from "@modules/apple-embeddings";
import { catchUpIndex } from "@/notes/embeddings";
import { useIndexStatus } from "@/notes/useIndexStatus";
import { SectionLabel } from "@/components/SectionLabel";
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
  const [unindexed, setUnindexed] = useState<UnindexedNote[]>([]);
  const [showDetails, setShowDetails] = useState(false);

  const refresh = useCallback(() => {
    let total = 0;
    let indexed = 0;
    const missing: UnindexedNote[] = [];
    for (const ws of listWorkspaceIds()) {
      const s = embeddingIndexStats(ws);
      total += s.liveNotes;
      indexed += s.indexedNotes;
      missing.push(...listUnindexedNotes(ws));
    }
    setStats({ indexed, total });
    setUnindexed(missing);
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
  // Notes with real body text that still produced no embedding rows — the
  // genuinely-suspicious ones (an empty note simply has nothing to embed).
  const withContent = unindexed.filter((n) => n.contentLen > 0);
  const emptyCount = unindexed.length - withContent.length;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Sparkles size={16} color={t.accent} />
        <SectionLabel>Semantic search index</SectionLabel>
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
            <View style={styles.countRow}>
              <Text style={styles.count}>
                {stats ? `${stats.indexed} of ${stats.total} notes indexed` : "—"}
              </Text>
              {unindexed.length > 0 && (
                <Pressable
                  onPress={() => setShowDetails((v) => !v)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Why aren't all notes indexed?"
                >
                  <Info size={15} color={t.textTertiary} />
                </Pressable>
              )}
            </View>
          )}

          <Text style={styles.help}>
            {behind > 0
              ? `${behind} note${behind === 1 ? "" : "s"} not yet indexed (e.g. just synced from another device). Reindex to search them by meaning.`
              : "All notes are indexed. On-device embeddings power semantic search — your notes never leave the device."}
          </Text>

          {showDetails && unindexed.length > 0 && (
            <View style={styles.details}>
              <Text style={styles.detailsIntro}>
                A note is only added to the semantic index if it has body text an
                embedding can be built from. These live notes currently have no
                index entry:
              </Text>
              {emptyCount > 0 && (
                <Text style={styles.detailsReason}>
                  • {emptyCount} empty note{emptyCount === 1 ? "" : "s"} (no body text) — nothing to
                  index. These aren&apos;t counted in the total.
                </Text>
              )}
              {withContent.length > 0 && (
                <>
                  <Text style={styles.detailsReason}>
                    • {withContent.length} note{withContent.length === 1 ? "" : "s"} with content that
                    hasn&apos;t been embedded yet. Tap Reindex to try again — if
                    one keeps failing, its body may have no indexable words (only
                    symbols, links, or an image). Opening it and adding a little
                    text will let it index:
                  </Text>
                  {withContent.slice(0, 8).map((n) => (
                    <Text key={n.id} style={styles.detailsItem} numberOfLines={1}>
                      – {n.title || "Untitled"}
                    </Text>
                  ))}
                  {withContent.length > 8 && (
                    <Text style={styles.detailsItem}>
                      …and {withContent.length - 8} more
                    </Text>
                  )}
                </>
              )}
            </View>
          )}

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
    card: { padding: 16, backgroundColor: t.surface2, borderRadius: 12, borderWidth: 1, borderColor: t.border, marginTop: 16 },
    header: { flexDirection: "row", alignItems: "center", gap: 8 },

    statusRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
    progress: { ...typeScale.control, color: t.textSecondary },
    countRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
    count: { ...typeScale.control, color: t.textPrimary },
    help: { ...typeScale.caption, color: t.textTertiary, marginTop: 10, lineHeight: 18 },
    details: {
      marginTop: 12,
      padding: 12,
      backgroundColor: t.surface3,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border,
      gap: 6,
    },
    detailsIntro: { ...typeScale.caption, color: t.textSecondary, lineHeight: 18 },
    detailsReason: { ...typeScale.caption, color: t.textTertiary, lineHeight: 18 },
    detailsItem: { ...typeScale.caption, color: t.textTertiary, marginLeft: 8 },
    button: { backgroundColor: t.surface3, borderWidth: 1, borderColor: t.border, paddingVertical: 12, borderRadius: 10, alignItems: "center", marginTop: 14 },
    buttonDisabled: { opacity: 0.6 },
    buttonText: { ...typeScale.control, color: t.accent },
  });
}
