import { useCallback, useMemo, useState } from "react";
import { View, Text, ScrollView, StyleSheet, Pressable, Alert } from "react-native";
import { Stack } from "expo-router";
import { Trash2 } from "lucide-react-native";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { useModalOpenHaptic } from "@/haptics";
import {
  loadChatUsageHistory,
  clearChatUsageHistory,
  type ChatUsageRow,
} from "@/db/chat-store";

/**
 * Usage — mobile chat token/cost tracker. Local-only (the chat_usage table has
 * no capture trigger), so it reflects what this device spent chatting. Totals,
 * a 14-day daily bar chart (plain Views), and a per-turn history list.
 */
export default function UsageSettingsScreen() {
  useModalOpenHaptic();
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);

  const [history, setHistory] = useState<ChatUsageRow[]>(() => loadChatUsageHistory());

  const totals = useMemo(() => {
    let prompt = 0;
    let completion = 0;
    let reasoning = 0;
    let cost = 0;
    let costEstimated = 0;
    for (const r of history) {
      prompt += r.promptTokens;
      completion += r.completionTokens;
      reasoning += r.reasoningTokens;
      if (r.costUsd != null) {
        if (r.estimated) costEstimated += r.costUsd;
        else cost += r.costUsd;
      }
    }
    return { prompt, completion, reasoning, cost, costEstimated, requests: history.length };
  }, [history]);

  const daily = useMemo(() => {
    const days: { label: string; tokens: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      let tokens = 0;
      for (const r of history) {
        if (r.createdAt.slice(0, 10) === key) tokens += r.promptTokens + r.completionTokens;
      }
      days.push({ label: d.toLocaleDateString(undefined, { weekday: "narrow" }), tokens });
    }
    const max = Math.max(1, ...days.map((d) => d.tokens));
    return { days, max };
  }, [history]);

  const confirmClear = useCallback(() => {
    Alert.alert("Clear usage history?", "This wipes the token/cost history on this device. This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => {
          clearChatUsageHistory();
          setHistory([]);
        },
      },
    ]);
  }, []);

  return (
    <>
      <Stack.Screen options={{ title: "Usage" }} />
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.body}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Totals</Text>
          <View style={styles.totalsRow}>
            <Stat label="Requests" value={String(totals.requests)} t={t} />
            <Stat label="Tokens" value={formatTokens(totals.prompt + totals.completion)} t={t} />
            <Stat label="Cost" value={`$${((totals.cost + totals.costEstimated) / 100).toFixed(2)}`} t={t} />
          </View>
          <Text style={styles.sectionHint}>
            {totals.costEstimated > 0
              ? `Includes ~$${(totals.costEstimated / 100).toFixed(2)} estimated (provider reported no cost).`
              : "Cost is what the provider reported; totals are per device, not synced."}
          </Text>
        </View>

        {history.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Last 14 days</Text>
            <View style={styles.chart}>
              {daily.days.map((d, i) => (
                <View key={i} style={styles.barCol}>
                  <View style={styles.barTrack}>
                    <View style={[styles.barFill, { height: `${Math.max(6, (d.tokens / daily.max) * 100)}%` }]} />
                  </View>
                  <Text style={styles.barLabel}>{d.label}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>History</Text>
          {history.length === 0 ? (
            <Text style={styles.sectionHint}>
              No usage recorded yet — send a chat message and the tokens here will fill in.
            </Text>
          ) : (
            <View style={styles.list}>
              {history.map((r) => (
                <View key={r.seq} style={styles.row}>
                  <View style={styles.rowMain}>
                    <Text style={styles.rowTitle}>
                      {r.provider}
                      {r.model ? <Text style={styles.rowModel}> · {r.model}</Text> : null}
                    </Text>
                    <Text style={styles.rowSub}>
                      {formatWhen(r.createdAt)} · {formatTokens(r.promptTokens + r.completionTokens)}
                      {r.reasoningTokens > 0 ? ` · ${formatTokens(r.reasoningTokens)} thinking` : ""}
                    </Text>
                  </View>
                  {r.costUsd != null && (
                    <Text style={styles.rowCost}>
                      ${(r.costUsd / 100).toFixed(2)}
                      {r.estimated ? "~" : ""}
                    </Text>
                  )}
                </View>
              ))}
            </View>
          )}
        </View>

        {history.length > 0 && (
          <Pressable style={styles.clearBtn} onPress={confirmClear} accessibilityRole="button">
            <Trash2 size={14} color={t.danger} />
            <Text style={styles.clearText}>Clear usage history</Text>
          </Pressable>
        )}
      </ScrollView>
    </>
  );
}

function Stat({ label, value, t }: { label: string; value: string; t: Theme }) {
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    flex: { flex: 1 },
    body: { padding: 16, gap: 20, paddingBottom: 40 },
    section: { gap: 8 },
    sectionLabel: { ...typeScale.overline, color: t.textTertiary },
    sectionHint: { ...typeScale.caption, color: t.textSecondary, lineHeight: 17 },
    totalsRow: { flexDirection: "row", gap: 8 },
    stat: {
      flex: 1,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 10,
      alignItems: "center",
    },
    statValue: { ...typeScale.subtitle, fontWeight: "700", color: t.textPrimary },
    statLabel: { ...typeScale.caption, color: t.textSecondary, marginTop: 2 },
    chart: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 5,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 10,
      height: 130,
    },
    barCol: { flex: 1, alignItems: "center", gap: 4, height: "100%", justifyContent: "flex-end" },
    barTrack: {
      flex: 1,
      width: "100%",
      justifyContent: "flex-end",
      backgroundColor: t.border,
      borderRadius: 3,
      overflow: "hidden",
    },
    barFill: { width: "100%", backgroundColor: t.accent, borderRadius: 3 },
    barLabel: { ...typeScale.caption, color: t.textTertiary },
    list: { gap: 6 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 12,
      paddingVertical: 10,
      paddingHorizontal: 12,
    },
    rowMain: { flex: 1, gap: 2 },
    rowTitle: { ...typeScale.control, color: t.textPrimary },
    rowModel: { ...typeScale.control, color: t.textTertiary },
    rowSub: { ...typeScale.caption, color: t.textSecondary },
    rowCost: { ...typeScale.control, color: t.textSecondary },
    clearBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 12,
      paddingVertical: 12,
    },
    clearText: { ...typeScale.control, color: t.danger },
  });
}
