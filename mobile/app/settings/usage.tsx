import { useCallback, useMemo, useState } from "react";
import { View, Text, ScrollView, StyleSheet, Pressable, Alert } from "react-native";
import { Stack } from "expo-router";
import { Trash2, ChevronDown } from "lucide-react-native";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { useModalOpenHaptic } from "@/haptics";
import { loadChatUsageHistory, clearChatUsageHistory, type ChatUsageRow } from "@/db/chat-store";
import { ProviderLogo } from "@/components/ProviderLogo";
import { getLogoProvider } from "@/chat/models-dev";

/**
 * Usage — mobile chat token/cost tracker, mirroring the desktop Usage view.
 * Local-only (the chat_usage table has no capture trigger), so it reflects what
 * this device spent chatting. Shows input vs output tokens, a cached-input
 * (cache hit rate) stat, a 14-day input/output chart, a by-model breakdown, and
 * a per-turn history — each row with its provider/model logo where one resolves.
 */
export default function UsageSettingsScreen() {
  useModalOpenHaptic();
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);

  const [history, setHistory] = useState<ChatUsageRow[]>(() => loadChatUsageHistory());
  const [showAllModels, setShowAllModels] = useState(false);

  const totals = useMemo(() => {
    let prompt = 0;
    let completion = 0;
    let reasoning = 0;
    let cacheRead = 0;
    let cacheCreate = 0;
    let cost = 0;
    let costEstimated = 0;
    for (const r of history) {
      prompt += r.promptTokens;
      completion += r.completionTokens;
      reasoning += r.reasoningTokens;
      cacheRead += r.cacheReadTokens;
      cacheCreate += r.cacheCreationTokens;
      if (r.costUsd != null) {
        if (r.estimated) costEstimated += r.costUsd;
        else cost += r.costUsd;
      }
    }
    return {
      prompt,
      completion,
      reasoning,
      cacheRead,
      cacheCreate,
      cost,
      costEstimated,
      requests: history.length,
    };
  }, [history]);

  // Cache hit rate: share of input served from the provider's cache.
  const cachePct = totals.prompt > 0 ? Math.round((totals.cacheRead / totals.prompt) * 100) : 0;
  const cacheColor = cachePct >= 50 ? t.success : cachePct >= 25 ? "#f59e0b" : t.textTertiary;

  const daily = useMemo(() => {
    const days: { label: string; input: number; output: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      let input = 0;
      let output = 0;
      for (const r of history) {
        if (r.createdAt.slice(0, 10) === key) {
          input += r.promptTokens;
          output += r.completionTokens;
        }
      }
      days.push({ label: d.toLocaleDateString(undefined, { weekday: "narrow" }), input, output });
    }
    const max = Math.max(1, ...days.map((d) => d.input + d.output));
    return { days, max };
  }, [history]);

  const byModel = useMemo(() => {
    const map = new Map<string, { model: string; prompt: number; completion: number; cacheRead: number; cost: number; estimated: boolean; count: number }>();
    for (const r of history) {
      const key = `${r.provider}::${r.model}`;
      const m = map.get(key) ?? { model: r.model, prompt: 0, completion: 0, cacheRead: 0, cost: 0, estimated: false, count: 0 };
      m.prompt += r.promptTokens;
      m.completion += r.completionTokens;
      m.cacheRead += r.cacheReadTokens;
      if (r.costUsd != null) m.cost += r.costUsd;
      m.estimated = m.estimated || r.estimated;
      m.count += 1;
      map.set(key, m);
    }
    return [...map.values()].sort((a, b) => b.prompt + b.completion - (a.prompt + a.completion));
  }, [history]);

  const visibleModels = showAllModels ? byModel : byModel.slice(0, 6);
  const hiddenModelCount = Math.max(0, byModel.length - visibleModels.length);

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
          <View style={styles.statGrid}>
            <Stat label="Input tokens" value={formatTokens(totals.prompt)} color={t.accent} t={t} />
            <Stat label="Output tokens" value={formatTokens(totals.completion)} t={t} />
            <Stat label="Cached input" value={formatTokens(totals.cacheRead)} color={cacheColor} t={t}
              sub={totals.prompt > 0 ? `${cachePct}% of input` : undefined} />
            <Stat label="Total cost" value={`$${((totals.cost + totals.costEstimated) / 100).toFixed(2)}`} t={t} />
          </View>
          <Text style={styles.sectionHint}>
            {totals.requests} chat turn{totals.requests === 1 ? "" : "s"} on this device
            {totals.costEstimated > 0 ? ` · ~$${(totals.costEstimated / 100).toFixed(2)} estimated (provider reported no cost)` : ""}.
          </Text>
        </View>

        {history.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Last 14 days</Text>
            <View style={styles.chart}>
              {daily.days.map((d, i) => {
                const total = d.input + d.output;
                const h = Math.max(6, (total / daily.max) * 100);
                const inputH = total > 0 ? (d.input / total) * h : h;
                return (
                  <View key={i} style={styles.barCol}>
                    <View style={styles.barTrack}>
                      <View style={[styles.barSegment, { height: `${inputH}%`, backgroundColor: t.accent }]} />
                      <View style={[styles.barSegment, { height: `${h - inputH}%`, backgroundColor: t.info }]} />
                    </View>
                    <Text style={styles.barLabel}>{d.label}</Text>
                  </View>
                );
              })}
            </View>
            <View style={styles.legend}>
              <LegendDot color={t.accent} label="Input" t={t} />
              <LegendDot color={t.info} label="Output" t={t} />
            </View>
          </View>
        )}

        {byModel.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>By model</Text>
            <View style={styles.list}>
              {visibleModels.map((m) => (
                <View key={m.model} style={styles.row}>
                  <ModelGlyph model={m.model} t={t} />
                  <View style={styles.rowMain}>
                    <Text style={styles.rowTitle}>{displayModel(m.model)}</Text>
                    <Text style={styles.rowSub}>
                      {m.count} call{m.count === 1 ? "" : "s"} · {formatTokens(m.prompt + m.completion)}
                      {m.cacheRead > 0 && m.prompt > 0 ? ` · ${Math.round((m.cacheRead / m.prompt) * 100)}% cached` : ""}
                    </Text>
                  </View>
                  {m.cost > 0 && (
                    <Text style={styles.rowCost}>
                      ${(m.cost / 100).toFixed(2)}
                      {m.estimated ? "~" : ""}
                    </Text>
                  )}
                </View>
              ))}
              {hiddenModelCount > 0 && (
                <Pressable style={styles.moreRow} onPress={() => setShowAllModels((v) => !v)} accessibilityRole="button">
                  <Text style={styles.moreText}>
                    {showAllModels ? "Show fewer" : `+${hiddenModelCount} more`}
                  </Text>
                  <ChevronDown size={14} color={t.textTertiary} style={showAllModels ? styles.chevUp : undefined} />
                </Pressable>
              )}
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
                  <ModelGlyph model={r.model} t={t} />
                  <View style={styles.rowMain}>
                    <Text style={styles.rowTitle}>
                      {r.provider}
                      {r.model && r.model !== r.provider ? <Text style={styles.rowModel}> · {displayModel(r.model)}</Text> : null}
                    </Text>
                    <Text style={styles.rowSub}>
                      {formatWhen(r.createdAt)} · in {formatTokens(r.promptTokens)} / out {formatTokens(r.completionTokens)}
                      {r.reasoningTokens > 0 ? ` · ${formatTokens(r.reasoningTokens)} thinking` : ""}
                      {r.cacheReadTokens > 0 && r.promptTokens > 0 ? ` · ${Math.round((r.cacheReadTokens / r.promptTokens) * 100)}% cached` : ""}
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

/** Logo when the model resolves to a models.dev provider, else a fallback dot. */
function ModelGlyph({ model, t }: { model: string; t: Theme }) {
  const styles = useMemo(() => makeStyles(t), [t]);
  const slug = getLogoProvider(model);
  if (!slug) {
    return <View style={[styles.dot, { backgroundColor: t.textTertiary }]} />;
  }
  return <ProviderLogo provider={slug} size={16} />;
}

function Stat({
  label,
  value,
  t,
  color,
  sub,
}: {
  label: string;
  value: string;
  t: Theme;
  color?: string;
  sub?: string;
}) {
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, color ? { color } : undefined]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
      {sub ? <Text style={[styles.statSub, color ? { color } : undefined]}>{sub}</Text> : null}
    </View>
  );
}

function LegendDot({ color, label, t }: { color: string; label: string; t: Theme }) {
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendSwatch, { backgroundColor: color }]} />
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

/** "rork"/"apple" are pseudo-models recorded from non-OpenAI providers. */
function displayModel(model: string): string {
  if (model === "rork") return "Rork";
  if (model === "apple") return "Apple Intelligence";
  return model;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    flex: { flex: 1 },
    body: { padding: 16, gap: 20, paddingBottom: 40 },
    section: { gap: 8 },
    sectionLabel: { ...typeScale.overline, color: t.textTertiary },
    sectionHint: { ...typeScale.caption, color: t.textSecondary, lineHeight: 17 },
    statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    stat: {
      width: "48%",
      flexGrow: 1,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 12,
    },
    statValue: { ...typeScale.subtitle, fontWeight: "700", color: t.textPrimary },
    statLabel: { ...typeScale.caption, color: t.textSecondary, marginTop: 2 },
    statSub: { ...typeScale.micro, marginTop: 1 },
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
      height: 150,
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
    barSegment: { width: "100%" },
    barLabel: { ...typeScale.caption, color: t.textTertiary },
    legend: { flexDirection: "row", gap: 14 },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
    legendSwatch: { width: 10, height: 10, borderRadius: 3 },
    legendLabel: { ...typeScale.caption, color: t.textSecondary },
    list: { gap: 6 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
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
    dot: { width: 16, height: 16, borderRadius: 8, opacity: 0.6 },
    moreRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
      paddingVertical: 8,
    },
    moreText: { ...typeScale.control, color: t.accent },
    chevUp: { transform: [{ rotate: "180deg" }] },
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
