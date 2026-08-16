/**
 * Usage body — mobile chat token/cost tracker. Mirrors the desktop Usage view:
 * stat cards (input/output/cached-input/cost/requests), a Tokens|Cost|Requests
 * line chart (input = accent, output = info), a by-model breakdown with
 * proportional bars, and a per-turn history. Local-only (the chat_usage table
 * has no capture trigger), so it reflects what this device spent chatting.
 *
 * Shared by the standalone Settings → Usage route (which adds its own native
 * header + scroll wrapper) and the AI-settings rework's Usage tab.
 */

import { useCallback, useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, useWindowDimensions } from "react-native";
import { Trash2 } from "lucide-react-native";
import Svg, { Line, Path, Text as SvgText } from "react-native-svg";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { loadChatUsageHistory, clearChatUsageHistory, type ChatUsageRow } from "@/db/chat-store";
import { ProviderLogo } from "@/components/ProviderLogo";
import { getLogoProvider } from "@/chat/models-dev";
import { formatUsd } from "@cairn/shared/chat/provider-credits";

type Metric = "tokens" | "cost" | "requests";

const CHART_H = 220;
const PAD_L = 44;
const PAD_R = 12;
const PAD_T = 16;
const PAD_B = 26;

/** The usage UI. `width` overrides the chart width (e.g. inside a tab panel). */
export function UsageBody({ width }: { width?: number }) {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const { width: screenW } = useWindowDimensions();
  const chartW = width ?? Math.min(screenW - 48, 560);

  const [history, setHistory] = useState<ChatUsageRow[]>(() => loadChatUsageHistory());
  const [metric, setMetric] = useState<Metric>("tokens");
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
    return { prompt, completion, reasoning, cacheRead, cacheCreate, cost, costEstimated, requests: history.length };
  }, [history]);

  // Cache hit rate: share of input served from the provider's cache.
  const cachePct = totals.prompt > 0 ? Math.round((totals.cacheRead / totals.prompt) * 100) : 0;
  const cacheColor = cachePct >= 50 ? t.success : cachePct >= 25 ? t.warning : t.textTertiary;

  const series = useMemo(() => {
    const days: { day: string; input: number; output: number; cost: number; requests: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      let input = 0;
      let output = 0;
      let cost = 0;
      let requests = 0;
      for (const r of history) {
        if (r.createdAt.slice(0, 10) === key) {
          input += r.promptTokens;
          output += r.completionTokens;
          if (r.costUsd != null) cost += r.costUsd;
          requests += 1;
        }
      }
      days.push({ day: d.toLocaleDateString(undefined, { weekday: "short" }), input, output, cost, requests });
    }
    return days;
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
  const modelMax = Math.max(1, ...byModel.map((m) => m.prompt + m.completion));

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

  const hasAny = history.length > 0;

  return (
    <>
      {/* Stat cards — mirror desktop */}
      <View style={styles.section}>
        <View style={styles.statGrid}>
          <Stat label="Input tokens" value={hasAny ? formatCompact(totals.prompt) : "—"} color={t.accent} />
          <Stat label="Output tokens" value={hasAny ? formatCompact(totals.completion) : "—"} />
          <Stat label="Cached input" value={hasAny ? formatCompact(totals.cacheRead) : "—"} color={cacheColor} sub={hasAny && totals.prompt > 0 ? `${cachePct}% of input` : undefined} />
          <Stat label="Total cost" value={hasAny ? formatUsd(totals.cost + totals.costEstimated) : "—"} />
          <Stat label="Requests" value={hasAny ? String(totals.requests) : "—"} />
        </View>
        <Text style={styles.sectionHint}>
          {hasAny && totals.costEstimated > 0 ? "~ = estimated from provider pricing when no cost was reported." : "Local to this device — not synced."}
        </Text>
      </View>

      {/* Chart + by model */}
      {hasAny && (
        <View style={styles.twoCol}>
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>{metric === "tokens" ? "Token usage" : metric === "cost" ? "Cost" : "Requests"}</Text>
              <Text style={styles.cardSub}>{metric === "tokens" ? "daily totals" : metric === "cost" ? "per day" : "chat calls per day"}</Text>
            </View>
            <View style={styles.metricRow}>
              <MetricButton label="Tokens" active={metric === "tokens"} onPress={() => setMetric("tokens")} />
              <MetricButton label="Cost" active={metric === "cost"} onPress={() => setMetric("cost")} />
              <MetricButton label="Requests" active={metric === "requests"} onPress={() => setMetric("requests")} />
            </View>
            <View style={styles.legend}>
              <LegendDot color={t.accent} label="Input" />
              <LegendDot color={t.info} label="Output" />
            </View>
            <UsageLineChart
              series={series}
              metric={metric}
              width={chartW}
              t={t}
            />
          </View>

          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>By model</Text>
              <Text style={styles.cardSub}>last 14 days</Text>
            </View>
            <View style={styles.byModelList}>
              {visibleModels.map((m) => (
                <View key={m.model} style={styles.byModelRow}>
                  <View style={styles.byModelTop}>
                    <View style={styles.byModelName}>
                      <ModelGlyph model={m.model} />
                      <Text style={styles.byModelModel} numberOfLines={1}>{displayModel(m.model)}</Text>
                    </View>
                    <Text style={styles.byModelMeta} numberOfLines={1}>
                      <Text style={styles.byModelTokens}>{formatCompact(m.prompt + m.completion)}</Text>
                      {m.cost > 0 ? <Text> · {formatUsd(m.cost)}{m.estimated ? "~" : ""}</Text> : null}
                    </Text>
                  </View>
                  <View style={styles.byModelTrack}>
                    <View style={[styles.byModelFill, { width: `${Math.max(2, ((m.prompt + m.completion) / modelMax) * 100)}%`, backgroundColor: modelColor(m.model, t), opacity: 0.85 }]} />
                  </View>
                </View>
              ))}
              {hiddenModelCount > 0 && (
                <Pressable style={styles.moreRow} onPress={() => setShowAllModels((v) => !v)} accessibilityRole="button">
                  <Text style={styles.moreText}>{showAllModels ? "Show fewer" : `+${hiddenModelCount} more`}</Text>
                </Pressable>
              )}
            </View>
          </View>
        </View>
      )}

      {/* History */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionLabel}>Usage history</Text>
          {hasAny && <Text style={styles.cardSub}>latest {history.length} calls</Text>}
        </View>
        {!hasAny ? (
          <Text style={styles.sectionHint}>No usage recorded yet — send a chat message and it will appear here.</Text>
        ) : (
          <View style={styles.list}>
            {history.map((r) => (
              <View key={r.seq} style={styles.row}>
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle}>
                    <ModelGlyphInline model={r.model} />
                    <Text> {r.provider}{r.model && r.model !== r.provider ? <Text style={styles.rowModel}> · {displayModel(r.model)}</Text> : null}</Text>
                  </Text>
                  <Text style={styles.rowSub}>
                    {formatWhen(r.createdAt)} · in {formatCompact(r.promptTokens)} / out {formatCompact(r.completionTokens)}
                    {r.reasoningTokens > 0 ? ` / think ${formatCompact(r.reasoningTokens)}` : ""}
                    {r.cacheReadTokens > 0 && r.promptTokens > 0 ? ` / ${Math.round((r.cacheReadTokens / r.promptTokens) * 100)}% cached` : ""}
                  </Text>
                </View>
                {r.costUsd != null && (
                  <Text style={styles.rowCost}>{formatUsd(r.costUsd)}{r.estimated ? "~" : ""}</Text>
                )}
              </View>
            ))}
          </View>
        )}
      </View>

      {hasAny && (
        <Pressable style={styles.clearBtn} onPress={confirmClear} accessibilityRole="button">
          <Trash2 size={14} color={t.danger} />
          <Text style={styles.clearText}>Clear usage history</Text>
        </Pressable>
      )}
    </>
  );
}

// ── Stat card ────────────────────────────────────────────────────────────────

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <View style={stylesStat.card}>
      <Text style={[stylesStat.value, color ? { color } : null]} numberOfLines={1}>{value}</Text>
      <Text style={stylesStat.label}>{label}</Text>
      {sub ? <Text style={stylesStat.sub}>{sub}</Text> : null}
    </View>
  );
}
const stylesStat = StyleSheet.create({
  card: { flex: 1, minWidth: "30%", gap: 2 },
  value: { ...typeScale.title, color: "#a09c96", fontVariant: ["tabular-nums"] },
  label: { ...typeScale.caption, color: "#66635f" },
  sub: { ...typeScale.micro, color: "#66635f" },
});

function MetricButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={[stylesMBtn.btn, active && stylesMBtn.active]} onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: active }}>
      <Text style={[stylesMBtn.text, active && stylesMBtn.activeText]}>{label}</Text>
    </Pressable>
  );
}
const stylesMBtn = StyleSheet.create({
  btn: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, backgroundColor: "#1a1a1a", borderWidth: 1, borderColor: "#2a2a2a" },
  active: { backgroundColor: "#8faf6f", borderColor: "#8faf6f" },
  text: { ...typeScale.caption, color: "#9e9a94" },
  activeText: { color: "#131c0b", fontWeight: "600" },
});

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <View style={stylesLegend.row}>
      <View style={[stylesLegend.dot, { backgroundColor: color }]} />
      <Text style={stylesLegend.label}>{label}</Text>
    </View>
  );
}
const stylesLegend = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 5 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { ...typeScale.micro, color: "#9e9a94" },
});

function ModelGlyph({ model }: { model: string }) {
  const provider = getLogoProvider(model);
  if (!provider) return <View style={stylesGlyph.placeholder} />;
  return <ProviderLogo provider={provider} size={18} />;
}
const stylesGlyph = StyleSheet.create({
  placeholder: { width: 18, height: 18 },
});

function ModelGlyphInline({ model }: { model: string }) {
  return <ModelGlyph model={model} />;
}

function modelColor(model: string, t: Theme): string {
  const name = (model || "").toLowerCase();
  if (name.includes("gpt") || name.includes("o3") || name.includes("o4")) return t.accent;
  if (name.includes("claude")) return "#d97706";
  if (name.includes("gemini")) return "#2563eb";
  if (name.includes("deepseek")) return "#7c3aed";
  return t.info;
}

function displayModel(model: string): string {
  return (model || "unknown").replace(/^[a-z0-9._-]+\//, "").slice(0, 28);
}

function formatCompact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const mins = Math.round((now.getTime() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Chart ────────────────────────────────────────────────────────────────────

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  const n = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return n * p;
}

function UsageLineChart({
  series,
  metric,
  width,
  t,
}: {
  series: { day: string; input: number; output: number; cost: number; requests: number }[];
  metric: Metric;
  width: number;
  t: Theme;
}) {
  const W = width;
  const H = CHART_H;

  const values = series.map((d) => (metric === "tokens" ? d.input + d.output : metric === "cost" ? d.cost : d.requests));
  const max = niceCeil(Math.max(...values, 1));
  const iMax = niceCeil(Math.max(...series.map((d) => d.input + d.output), 1));
  const cMax = niceCeil(Math.max(...series.map((d) => d.cost), 0.001));
  const rMax = niceCeil(Math.max(...series.map((d) => d.requests), 1));
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const step = series.length > 1 ? innerW / (series.length - 1) : innerW;
  const x = (i: number) => PAD_L + i * step;
  const yFor = (v: number, m: number) => PAD_T + innerH - (v / m) * innerH;

  // Gridlines at nice intervals (aim ~4-5).
  const gridLines: { v: number; label: string }[] = [];
  const stepVal = max / 4;
  for (let k = 0; k <= 4; k++) {
    gridLines.push({ v: PAD_T + innerH - (k * stepVal) / max * innerH, label: formatCompact(Math.round(k * stepVal)) });
  }

  const line = (d: "input" | "output", m: number) =>
    series
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${yFor(d === "input" ? p.input : p.output, m)}`)
      .join(" ");

  return (
    <Svg width={W} height={H}>
      {gridLines.map((g, i) => (
        <Line key={i} x1={PAD_L} y1={g.v} x2={W - PAD_R} y2={g.v} stroke={t.border} strokeWidth={1} strokeDasharray="3 4" />
      ))}
      {gridLines.map((g, i) => (
        <SvgText key={`l${i}`} x={PAD_L - 6} y={g.v + 4} fontSize={10} fill={t.textTertiary} textAnchor="end">{g.label}</SvgText>
      ))}
      {/* Input + output lines (tokens) or cost / requests lines */}
      {metric === "tokens" ? (
        <>
          <Path d={line("input", iMax)} fill="none" stroke={t.accent} strokeWidth={2} />
          <Path d={line("output", iMax)} fill="none" stroke={t.info} strokeWidth={2} />
        </>
      ) : (
        <Path d={line("input", metric === "cost" ? cMax : rMax)} fill="none" stroke={t.accent} strokeWidth={2} />
      )}
      {/* X labels */}
      {series.map((d, i) => {
        if (i % 2 !== 0 && i !== series.length - 1) return null;
        return (
          <SvgText key={`x${i}`} x={x(i)} y={H - 8} fontSize={9} fill={t.textTertiary} textAnchor="middle">{d.day}</SvgText>
        );
      })}
    </Svg>
  );
}

// ── Styles (shared by the standalone route + the tab body) ───────────────────

function makeStyles(t: Theme) {
  return StyleSheet.create({
    flex: { flex: 1 },
    body: { padding: 18, gap: 20 },
    section: { gap: 8 },
    sectionHeader: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
    sectionLabel: { ...typeScale.overline, color: t.textTertiary },
    sectionHint: { ...typeScale.caption, color: t.textSecondary, lineHeight: 16 },
    statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
    twoCol: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
    card: {
      flex: 1,
      minWidth: 240,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 12,
      padding: 12,
      gap: 8,
    },
    cardHeader: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
    cardTitle: { ...typeScale.control, color: t.textPrimary, fontWeight: "600" },
    cardSub: { ...typeScale.caption, color: t.textTertiary },
    metricRow: { flexDirection: "row", gap: 6 },
    legend: { flexDirection: "row", gap: 14 },
    byModelList: { gap: 10 },
    byModelRow: { gap: 4 },
    byModelTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
    byModelName: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 },
    byModelModel: { ...typeScale.caption, color: t.textPrimary, flexShrink: 1 },
    byModelMeta: { ...typeScale.micro, color: t.textTertiary },
    byModelTokens: { color: t.textSecondary, fontWeight: "600" },
    byModelTrack: { height: 5, borderRadius: 3, backgroundColor: t.surface3, overflow: "hidden" },
    byModelFill: { height: 5, borderRadius: 3 },
    moreRow: { paddingVertical: 4 },
    moreText: { ...typeScale.caption, color: t.accent },
    list: { gap: 0 },
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 12,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    rowMain: { flex: 1, gap: 2 },
    rowTitle: { ...typeScale.caption, color: t.textPrimary },
    rowModel: { color: t.textTertiary },
    rowSub: { ...typeScale.micro, color: t.textTertiary, lineHeight: 15 },
    rowCost: { ...typeScale.caption, color: t.textSecondary, fontVariant: ["tabular-nums"] },
    clearBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingVertical: 10,
      marginTop: 4,
    },
    clearText: { ...typeScale.caption, color: t.danger },
  });
}

// Keep the chart-side styles module-scoped (they don't depend on the theme).
void niceCeil;
