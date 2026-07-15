import { useCallback, useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, Alert, TextInput } from "react-native";
import { Stack, useRouter } from "expo-router";
import { GitMerge } from "lucide-react-native";
import {
  listConflictCopies,
  resolveConflictKeepCopy,
  resolveConflictKeepOriginal,
  resolveConflictKeepMerged,
  type ConflictCopy,
} from "@/db/queries";
import { merge3 } from "@cairn/shared/sync/merge3";
import { diffLines, diffStats, type DiffRow } from "@cairn/shared/sync/line-diff";
import { useRefreshOnFocus } from "@/sync/useSyncStatus";
import { useTheme, type as typeScale, type Theme, withAlpha } from "@/theme";

/**
 * Manual conflict-resolution screen. Lists every conflict-copy note (created
 * when the same note body diverged on two devices while offline) side-by-side
 * with its original, and lets the user keep either version OR merge them.
 * Merge auto-combines non-overlapping edits (e.g. two different checklist items
 * added); overlapping edits open an editable box. Never silent loss.
 */
export default function ConflictsScreen() {
  const t = useTheme();
  const router = useRouter();
  const [conflicts, setConflicts] = useState<ConflictCopy[]>([]);
  // Per-conflict manual-merge draft (id → text). Presence = editor open.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const styles = useMemo(() => makeStyles(t), [t]);

  const load = useCallback(() => setConflicts(listConflictCopies()), []);
  useRefreshOnFocus(load);

  const closeDraft = (id: string) =>
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const keepCopy = (c: ConflictCopy) => {
    Alert.alert("Replace the original?", "This copy overwrites the original note. The original version is discarded.", [
      { text: "Cancel", style: "cancel" },
      { text: "Replace original", style: "destructive", onPress: () => { resolveConflictKeepCopy(c.id); load(); } },
    ]);
  };
  const keepOriginal = (c: ConflictCopy) => {
    Alert.alert("Discard this copy?", "The original note is kept and this conflicted copy is deleted.", [
      { text: "Cancel", style: "cancel" },
      { text: "Discard copy", style: "destructive", onPress: () => { resolveConflictKeepOriginal(c.id); load(); } },
    ]);
  };
  const merge = (c: ConflictCopy) => {
    const ours = c.original?.content ?? "";
    const theirs = c.content ?? "";
    const result = merge3(c.baseBody, ours, theirs);
    if (result.clean) {
      Alert.alert("Merge both versions?", "The changes from both devices are combined into the original note.", [
        { text: "Cancel", style: "cancel" },
        { text: "Merge", onPress: () => { resolveConflictKeepMerged(c.id, result.merged); load(); } },
      ]);
    } else {
      // Overlapping edits — open the editable draft for manual reconciliation.
      setDrafts((prev) => ({ ...prev, [c.id]: result.merged }));
    }
  };
  const saveMerged = (c: ConflictCopy) => {
    resolveConflictKeepMerged(c.id, drafts[c.id] ?? "");
    closeDraft(c.id);
    load();
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
            {conflicts.length} note{conflicts.length === 1 ? "" : "s"} diverged. Keep one version, or merge both.
          </Text>
          {conflicts.map((c) => {
            const editing = c.id in drafts;
            return (
              <View key={c.id} style={styles.card}>
                <Pressable onPress={() => router.push(`/note/${c.id}`)}>
                  <Text style={styles.cardTitle} numberOfLines={2}>{c.title}</Text>
                </Pressable>
                {c.deviceId ? <Text style={styles.meta}>Copy from {c.deviceId}</Text> : null}

                {editing ? (
                  <View style={styles.mergeBox}>
                    <Text style={styles.mergeHint}>Overlapping edits — review before saving</Text>
                    <TextInput
                      style={styles.mergeInput}
                      multiline
                      value={drafts[c.id]}
                      onChangeText={(text) => setDrafts((prev) => ({ ...prev, [c.id]: text }))}
                    />
                    <View style={styles.actions}>
                      <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => closeDraft(c.id)}>
                        <Text style={styles.btnGhostText}>Cancel</Text>
                      </Pressable>
                      <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => saveMerged(c)}>
                        <Text style={styles.btnPrimaryText}>Save merged</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <>
                    <DiffView
                      current={c.original ? (c.original.content ?? "") : ""}
                      copy={c.content ?? ""}
                      originalDeleted={!c.original}
                      styles={styles}
                      t={t}
                    />

                    <View style={styles.actions}>
                      <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => keepOriginal(c)}>
                        <Text style={styles.btnGhostText}>Keep original</Text>
                      </Pressable>
                      <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => keepCopy(c)}>
                        <Text style={styles.btnGhostText}>Keep copy</Text>
                      </Pressable>
                      <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => merge(c)}>
                        <Text style={styles.btnPrimaryText}>Merge</Text>
                      </Pressable>
                    </View>
                  </>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

/**
 * Unified line-diff of the current note vs the conflicted copy. Lines only in
 * the current note are shown red ("−"), lines only in the copy green ("+"),
 * unchanged lines dimmed — so it's clear exactly what differs rather than two
 * opaque text previews. Falls back to a plain preview when the original was
 * deleted (nothing to diff against).
 */
function DiffView({
  current,
  copy,
  originalDeleted,
  styles,
  t,
}: {
  current: string;
  copy: string;
  originalDeleted: boolean;
  styles: ReturnType<typeof makeStyles>;
  t: Theme;
}) {
  if (originalDeleted) {
    return (
      <View style={styles.diffWrap}>
        <Text style={styles.versionLabel}>Original was deleted — conflicted copy</Text>
        <Text style={styles.versionBody} numberOfLines={6}>
          {copy.trim().length > 0 ? copy.replace(/\s+/g, " ").trim().slice(0, 240) : "(empty)"}
        </Text>
      </View>
    );
  }

  const rows: DiffRow[] = diffLines(current, copy);
  const { added, removed } = diffStats(rows);
  const identical = added === 0 && removed === 0;

  if (identical) {
    return (
      <View style={styles.diffWrap}>
        <Text style={styles.versionLabel}>Current vs conflicted copy</Text>
        <Text style={styles.diffSame}>Both versions have the same body — the conflict is in metadata only.</Text>
      </View>
    );
  }

  return (
    <View style={styles.diffWrap}>
      <View style={styles.diffHeader}>
        <Text style={styles.versionLabel}>Current vs conflicted copy</Text>
        <View style={styles.diffCounts}>
          {added > 0 ? <Text style={[styles.diffCount, { color: t.success }]}>+{added} in copy</Text> : null}
          {removed > 0 ? <Text style={[styles.diffCount, { color: t.danger }]}>−{removed} in current</Text> : null}
        </View>
      </View>
      <ScrollView style={styles.diffScroll} nestedScrollEnabled>
        {rows.map((row, i) => {
          const isAdd = row.op === "add";
          const isRemove = row.op === "remove";
          return (
            <View
              key={i}
              style={[
                styles.diffRow,
                isAdd && styles.diffRowAdd,
                isRemove && styles.diffRowRemove,
              ]}
            >
              <Text style={[styles.diffSign, { color: isAdd ? t.success : isRemove ? t.danger : "transparent" }]}>
                {isAdd ? "+" : isRemove ? "−" : " "}
              </Text>
              <Text style={[styles.diffLine, { color: row.op === "equal" ? t.textTertiary : t.textPrimary }]}>
                {row.text.length > 0 ? row.text : " "}
              </Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.background },
    scroll: { padding: 16, paddingBottom: 48 },
    intro: { ...typeScale.caption, color: t.textSecondary, marginBottom: 14, lineHeight: 19 },
    card: { backgroundColor: t.surface, borderRadius: 14, borderWidth: 1, borderColor: t.border, padding: 14, marginBottom: 16 },
    cardTitle: { ...typeScale.title, fontWeight: "700", color: t.textPrimary },
    meta: { ...typeScale.caption, color: t.textTertiary, marginTop: 4 },
    versionLabel: { ...typeScale.overline, color: t.textTertiary, marginBottom: 6 },
    versionBody: { ...typeScale.caption, color: t.textPrimary, lineHeight: 19 },
    // Unified diff view
    diffWrap: { marginTop: 12, backgroundColor: t.surface2, borderRadius: 10, borderWidth: 1, borderColor: t.borderSubtle, padding: 10 },
    diffHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
    diffCounts: { flexDirection: "row", gap: 10 },
    diffCount: { ...typeScale.micro, fontWeight: "600" },
    diffScroll: { maxHeight: 220 },
    diffRow: { flexDirection: "row", paddingHorizontal: 4, borderRadius: 3 },
    diffRowAdd: { backgroundColor: withAlpha(t.success, 0.16) },
    diffRowRemove: { backgroundColor: withAlpha(t.danger, 0.16) },
    diffSign: { width: 14, fontFamily: "Menlo", fontSize: 12, lineHeight: 19 },
    diffLine: { flex: 1, fontFamily: "Menlo", fontSize: 12, lineHeight: 19 },
    diffSame: { ...typeScale.caption, color: t.textTertiary, fontStyle: "italic", lineHeight: 19 },
    actions: { flexDirection: "row", gap: 10, marginTop: 14 },
    btn: { flex: 1, paddingVertical: 11, borderRadius: 10, alignItems: "center" },
    btnGhost: { backgroundColor: t.surface2, borderWidth: 1, borderColor: t.border },
    btnGhostText: { ...typeScale.control, color: t.textSecondary },
    btnPrimary: { backgroundColor: t.accent },
    btnPrimaryText: { ...typeScale.control, fontWeight: "700", color: t.accentFg },
    mergeBox: { marginTop: 12, gap: 8 },
    mergeHint: { ...typeScale.overline, color: t.warning },
    mergeInput: {
      minHeight: 160,
      backgroundColor: t.surface2,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border,
      padding: 10,
      color: t.textPrimary,
      ...typeScale.caption,
      textAlignVertical: "top",
    },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40, gap: 12 },
    emptyTitle: { ...typeScale.title, fontWeight: "700", color: t.textPrimary },
    emptyText: { ...typeScale.caption, color: t.textTertiary, textAlign: "center", lineHeight: 19 },
  });
}
