import { useCallback, useMemo, useState } from "react";
import { View, Text, ScrollView, StyleSheet, Pressable, Alert, useWindowDimensions } from "react-native";
import { Stack } from "expo-router";
import { Trash2 } from "lucide-react-native";
import Svg, { Line, Path, Circle, Text as SvgText } from "react-native-svg";
import { useTheme, type as typeScale, type Theme } from "@/theme";
import { useModalOpenHaptic } from "@/haptics";
import { loadChatUsageHistory, clearChatUsageHistory, type ChatUsageRow } from "@/db/chat-store";
import { ProviderLogo } from "@/components/ProviderLogo";
import { getLogoProvider } from "@/chat/models-dev";
import { formatUsd } from "@cairn/shared/chat/provider-credits";

/**
 * Usage — mobile chat token/cost tracker. Mirrors the desktop Usage view:
 * stat cards (input/output/cached-input/cost/requests), a Tokens|Cost|Requests
 * line chart (input = accent, output = info), a by-model breakdown with
 * proportional bars, and a per-turn history. Local-only (the chat_usage table
 * has no capture trigger), so it reflects what this device spent chatting.
 */
type Metric = "tokens" | "cost" | "requests";

const CHART_H = 220;
const PAD_L = 44;
const PAD_R = 12;
const PAD_T = 16;
const PAD_B = 26;

export default function UsageSettingsScreen() {
  useModalOpenHaptic();
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const { width: screenW } = useWindowDimensions();

  const [history, setHistory] = useState<ChatUsageRow[]>(() => loadChatUsageHistory());
  const [metric, setMetric] = useState<Metric>("tokens");
  const [showAllModels, setShowAllModels] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

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
      <Stack.Screen options={{ title: "Usage" }} />
      <ScrollView style={styles.flex} contentContainerStyle={styles.body} contentInsetAdjustmentBehavior="automatic">
        {/* Stat cards — mirror desktop */}
        <View style={styles.section}>
          <View style={styles.statGrid}>
            <Stat label="Input tokens" value={hasAny ? formatCompact(totals.prompt) : "—"} color={t.accent} t={t} />
            <Stat label="Output tokens" value={hasAny ? formatCompact(totals.completion) : "—"} t={t} />
            <Stat label="Cached input" value={hasAny ? formatCompact(totals.cacheRead) : "—"} color={cacheColor} t={t} sub={hasAny && totals.prompt > 0 ? `${cachePct}% of input` : undefined} />
            <Stat label="Total cost" value={hasAny ? formatUsd(totals.cost + totals.costEstimated) : "—"} t={t} />
            <Stat label="Requests" value={hasAny ? String(totals.requests) : "—"} t={t} />
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
                <MetricButton label="Tokens" active={metric === "tokens"} onPress={() => setMetric("tokens")} t={t} />
                <MetricButton label="Cost" active={metric === "cost"} onPress={() => setMetric("cost")} t={t} />
                <MetricButton label="Requests" active={metric === "requests"} onPress={() => setMetric("requests")} t={t} />
              </View>
              <View style={styles.legend}>
                <LegendDot color={t.accent} label="Input" t={t} />
                <LegendDot color={t.info} label="Output" t={t} />
              </View>
              <UsageLineChart
                series={series}
                metric={metric}
                width={Math.min(screenW - 48, 560)}
                t={t}
                hover={hover}
                onHover={setHover}
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
                        <ModelGlyph model={m.model} t={t} />
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
                      <ModelGlyphInline model={r.model} t={t} />
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
      </ScrollView>
    </>
  );
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
  hover,
  onHover,
}: {
  series: { day: string; input: number; output: number; cost: number; requests: number }[];
  metric: Metric;
  width: number;
  t: Theme;
  hover: number | null;
  onHover: (i: number | null) => void;
}) {
  const styles = useMemo(() => makeStyles(t), [t]);
  const n = series.length;
  const w = Math.max(1, width);
  const colW = (w - PAD_L - PAD_R) / Math.max(1, n - 1);
  const X = (i: number) => PAD_L + i * colW;

  const { yMax, yTicks, xLabels, inLine, outLine, area } = useMemo(() => {
    const out = (d: typeof series[0]) => (metric === "cost" ? d.cost : metric === "requests" ? d.requests : d.output);
    const ins = metric === "tokens" ? series.map((d) => d.input) : [];
    const outs = series.map(out);
    const top = Math.max(1, ...outs, ...ins);
    const nice = niceCeil(top);
    const Y = (v: number) => PAD_T + (CHART_H - PAD_T - PAD_B) * (1 - v / nice);
    const lineOf = (arr: number[]) => arr.map((v, i) => `${i === 0 ? "M" : "L"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    const ticks = [];
    for (let i = 0; i <= 4; i++) ticks.push({ v: (nice * i) / 4, y: Y((nice * i) / 4) });
    const labels = [];
    const step = n > 14 ? 4 : n > 7 ? 2 : 1;
    for (let i = 0; i < n; i += step) labels.push({ x: X(i), t: series[i].day });
    const inArr = lineOf(ins);
    const outArr = lineOf(outs);
    const areaPath = ins.length
      ? `${inArr} L${X(n - 1).toFixed(1)},${Y(0).toFixed(1)} L${X(0).toFixed(1)},${Y(0).toFixed(1)} Z`
      : null;
    return { yMax: nice, yTicks: ticks, xLabels: labels, inLine: ins.length ? inArr : null, outLine: outArr, area: areaPath };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, metric, w]);

  const hovered = hover != null ? series[hover] : null;
  const outY = (d: typeof series[0]) => PAD_T + (CHART_H - PAD_T - PAD_B) * (1 - (metric === "cost" ? d.cost : metric === "requests" ? d.requests : d.output) / yMax);
  const inY = (d: typeof series[0]) => PAD_T + (CHART_H - PAD_T - PAD_B) * (1 - d.input / yMax);
  const hoverX = hover != null ? X(hover) : 0;

  return (
    <View
      style={styles.chartWrap}
      onStartShouldSetResponder={() => true}
      onResponderGrant={(e) => {
        const x = e.nativeEvent.locationX;
        const idx = Math.round((x - PAD_L) / colW);
        onHover(idx >= 0 ? Math.min(idx, n - 1) : null);
      }}
      onResponderRelease={() => onHover(null)}
    >
      {series.length === 0 ? (
        <Text style={styles.chartEmpty}>No usage in this range yet.</Text>
      ) : (
        <Svg width={w} height={CHART_H}>
          {yTicks.map((tk, i) => (
            <View key={i}>
              <Line x1={PAD_L} x2={w - PAD_R} y1={tk.y} y2={tk.y} stroke={t.border} strokeWidth={1} />
              <SvgText x={PAD_L - 8} y={tk.y + 3} fontSize={10} fill={t.textTertiary} textAnchor="end">
                {metric === "cost" ? (tk.v >= 1 ? `$${tk.v.toFixed(0)}` : `$${tk.v.toFixed(2)}`) : formatCompact(tk.v)}
              </SvgText>
            </View>
          ))}
          {xLabels.map((l, i) => (
            <SvgText key={i} x={l.x} y={CHART_H - 8} fontSize={10} fill={t.textTertiary} textAnchor="middle">
              {l.t}
            </SvgText>
          ))}
          {metric === "tokens" && area && (
            <Path d={area} fill={withAlpha(t.accent, 0.16)} stroke="none" />
          )}
          {metric === "tokens" && inLine && (
            <Path d={inLine} fill="none" stroke={t.accent} strokeWidth={1.5} />
          )}
          {outLine && (
            <Path d={outLine} fill="none" stroke={t.info} strokeWidth={2} strokeLinejoin="round" />
          )}
          {series.length === 1 && (
            <>
              {metric === "tokens" && <Circle cx={PAD_L} cy={inY(series[0])} r={4} fill={t.accent} stroke={t.surface} strokeWidth={1.5} />}
              <Circle cx={PAD_L} cy={outY(series[0])} r={4} fill={t.info} stroke={t.surface} strokeWidth={1.5} />
            </>
          )}
          {hovered && (
            <>
              <Line x1={hoverX} x2={hoverX} y1={PAD_T} y2={CHART_H - PAD_B} stroke={t.textTertiary} strokeWidth={1} strokeDasharray="3 3" />
              {metric === "tokens" && <Circle cx={hoverX} cy={inY(hovered)} r={3.5} fill={t.accent} />}
              <Circle cx={hoverX} cy={outY(hovered)} r={3.5} fill={t.info} />
            </>
          )}
        </Svg>
      )}
      {hovered && (
        <View style={[styles.tooltip, { left: Math.min(w - 120, Math.max(4, hoverX - 60)) }]}>
          <Text style={styles.tooltipTitle}>{hovered.day}</Text>
          {metric === "tokens" ? (
            <>
              <Text style={styles.tooltipRow}><Text style={styles.tooltipKey}>Input</Text> <Text style={styles.tooltipVal}>{formatCompact(hovered.input)}</Text></Text>
              <Text style={styles.tooltipRow}><Text style={styles.tooltipKey}>Output</Text> <Text style={styles.tooltipVal}>{formatCompact(hovered.output)}</Text></Text>
            </>
          ) : (
            <Text style={styles.tooltipRow}>
              <Text style={styles.tooltipKey}>{metric === "cost" ? "Cost" : "Calls"}</Text>{" "}
              <Text style={styles.tooltipVal}>{metric === "cost" ? formatUsd(hovered.cost) : String(hovered.requests)}</Text>
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

// ── small pieces ─────────────────────────────────────────────────────────────

function Stat({ label, value, t, color, sub }: { label: string; value: string; t: Theme; color?: string; sub?: string }) {
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, color ? { color } : undefined]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
      {sub ? <Text style={[styles.statSub, color ? { color } : undefined]}>{sub}</Text> : null}
    </View>
  );
}

function MetricButton({ label, active, onPress, t }: { label: string; active: boolean; onPress: () => void; t: Theme }) {
  const styles = useMemo(() => makeStyles(t), [t]);
  return (
    <Pressable style={[styles.metricBtn, active && styles.metricBtnActive]} onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: active }}>
      <Text style={[styles.metricBtnText, active && styles.metricBtnTextActive]}>{label}</Text>
    </Pressable>
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

function ModelGlyph({ model, t }: { model: string; t: Theme }) {
  const styles = useMemo(() => makeStyles(t), [t]);
  const slug = getLogoProvider(model);
  if (!slug) return <View style={[styles.dot, { backgroundColor: modelColor(model, t) }]} />;
  return <ProviderLogo provider={slug} size={16} />;
}

function ModelGlyphInline({ model, t }: { model: string; t: Theme }) {
  const styles = useMemo(() => makeStyles(t), [t]);
  const slug = getLogoProvider(model);
  if (!slug) return <View style={[styles.dotSm, { backgroundColor: modelColor(model, t) }]} />;
  return <ProviderLogo provider={slug} size={12} />;
}

const MODEL_PALETTE = ["#818cf8", "#60a5fa", "#34d399", "#f59e0b", "#c084fc", "#f472b6", "#2dd4bf", "#94a3b8"];
function modelColor(model: string, t: Theme): string {
  void t;
  let h = 0;
  for (let i = 0; i < model.length; i++) h = (h * 31 + model.charCodeAt(i)) >>> 0;
  return MODEL_PALETTE[h % MODEL_PALETTE.length];
}

function withAlpha(hex: string, a: number): string {
  const m = hex.replace("#", "");
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const n = parseInt(full.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function displayModel(model: string): string {
  if (model === "rork") return "Rork";
  if (model === "apple") return "Apple Intelligence";
  return model;
}

function formatCompact(n: number): string {
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
    sectionHeader: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
    sectionLabel: { ...typeScale.overline, color: t.textTertiary },
    sectionHint: { ...typeScale.caption, color: t.textSecondary, lineHeight: 17 },
    statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    stat: {
      width: "30%",
      flexGrow: 1,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 12,
      minWidth: 96,
    },
    statValue: { ...typeScale.subtitle, fontWeight: "700", color: t.textPrimary },
    statLabel: { ...typeScale.caption, color: t.textSecondary, marginTop: 2 },
    statSub: { ...typeScale.micro, marginTop: 1 },
    twoCol: { gap: 12 },
    card: {
      backgroundColor: t.surface,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 14,
      padding: 12,
      gap: 8,
    },
    cardHeader: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
    cardTitle: { ...typeScale.control, fontWeight: "700", color: t.textPrimary },
    cardSub: { ...typeScale.caption, color: t.textTertiary },
    metricRow: { flexDirection: "row", backgroundColor: t.surface2, borderRadius: 8, padding: 2 },
    metricBtn: { flex: 1, alignItems: "center", paddingVertical: 6, borderRadius: 6 },
    metricBtnActive: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border },
    metricBtnText: { ...typeScale.control, color: t.textSecondary },
    metricBtnTextActive: { color: t.textPrimary, fontWeight: "600" },
    legend: { flexDirection: "row", gap: 14 },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
    legendSwatch: { width: 10, height: 10, borderRadius: 3 },
    legendLabel: { ...typeScale.caption, color: t.textSecondary },
    chartWrap: { position: "relative", height: CHART_H },
    chartEmpty: { ...typeScale.control, color: t.textTertiary, textAlign: "center", marginTop: 80 },
    axisLabel: { position: "absolute", left: 0, width: PAD_L - 8, textAlign: "right", ...typeScale.micro, color: t.textTertiary },
    axisX: { position: "absolute", bottom: 4, ...typeScale.micro, color: t.textTertiary },
    tooltip: {
      position: "absolute",
      top: 2,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
      shadowOpacity: 0.15,
      shadowRadius: 6,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      elevation: 4,
    },
    tooltipTitle: { ...typeScale.micro, color: t.textTertiary, textTransform: "uppercase", marginBottom: 2 },
    tooltipRow: { ...typeScale.caption, color: t.textSecondary, marginTop: 1 },
    tooltipKey: { color: t.textSecondary },
    tooltipVal: { color: t.textPrimary, fontWeight: "700", fontFamily: "monospace" },
    byModelList: { gap: 10 },
    byModelRow: { gap: 4 },
    byModelTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
    byModelName: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 },
    byModelModel: { ...typeScale.control, color: t.textPrimary, fontFamily: "monospace", flexShrink: 1 },
    byModelMeta: { ...typeScale.caption, color: t.textTertiary },
    byModelTokens: { color: t.textSecondary, fontFamily: "monospace" },
    byModelTrack: { height: 6, borderRadius: 3, backgroundColor: t.surface2, overflow: "hidden" },
    byModelFill: { height: "100%", borderRadius: 3 },
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
    dot: { width: 16, height: 16, borderRadius: 8, opacity: 0.7 },
    dotSm: { width: 12, height: 12, borderRadius: 6, opacity: 0.7 },
    moreRow: { alignItems: "center", paddingVertical: 6 },
    moreText: { ...typeScale.control, color: t.accent },
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
