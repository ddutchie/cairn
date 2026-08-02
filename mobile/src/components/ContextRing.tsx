import { useEffect, useMemo, useState } from "react";
import { Alert, Platform, Pressable, StyleSheet } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { Host, Popover, RNHostView, Button, VStack, HStack, Spacer, Text, Divider, Rectangle } from "@expo/ui/swift-ui";
import { font, foregroundStyle, frame, padding, monospacedDigit, clipShape, accessibilityLabel } from "@expo/ui/swift-ui/modifiers";
import { useTheme } from "@/theme";
import { haptics } from "@/haptics";
import { getActiveProvider, getProviderApiKey } from "@/chat/ai-config";
import { getKeyInfo, type ProviderKeyInfo } from "@/chat/providers/openai";
import type { ChatUsage } from "@/chat/providers/types";
import type { TokenBreakdown } from "@/chat/token-breakdown";

// Inner width of the popover content (POPOVER_WIDTH minus the 16pt padding each
// side) — the segmented bar's segments are sized in points against this.
const POPOVER_WIDTH = 260;
const BAR_INNER_WIDTH = POPOVER_WIDTH - 32;
const BAR_HEIGHT = 8;

/** Re-probe the account balance at most once per minute. */
const BALANCE_TTL_MS = 60_000;
let balanceCache: { baseUrl: string; data: ProviderKeyInfo | null; fetchedAt: number } | null = null;

/**
 * Context-window usage ring — the mobile analogue of the desktop ContextRing
 * (src/components/agent/ContextRing.tsx). A compact SVG donut whose arc fills
 * with the fraction of the model's context window used by the conversation.
 *
 * Tapping it opens a NATIVE SwiftUI popover (@expo/ui Popover) whose content is
 * arbitrary SwiftUI — so each row is a real two-column layout
 * (`HStack { name · Spacer · count }`) with the token counts right-aligned in a
 * proper column, unlike a native Menu (which forces single-line, system-styled
 * rows). The trigger is a native Button hosting the RN ring, so the tap is
 * consumed at the SwiftUI layer and never leaks to iOS's status-bar
 * "scroll to top" gesture (the reason a plain RN view in headerLeft misbehaved).
 *
 * Shows the per-category split (system prompt, tool definitions, MCP & services,
 * conversation, tool outputs) plus an Output section (answer / thinking / total)
 * once a turn completes. Threshold colours match desktop: accent <=65%,
 * warning 65–85%, danger >85%. Non-iOS falls back to an SVG ring + Alert.
 */
export function ContextRing({
  promptTokens,
  contextLimit,
  estimated = false,
  breakdown,
  completionTokens,
  reasoningTokens,
  costUsd,
  size = 22,
  stroke = 3.5,
}: {
  promptTokens: number;
  contextLimit: number;
  /** promptTokens is a client-side estimate (shown as "~" / "about"). */
  estimated?: boolean;
  breakdown?: TokenBreakdown;
  completionTokens?: number;
  reasoningTokens?: number;
  /** Provider-reported USD cost of the turn (e.g. Neuralwatt usage.cost). */
  costUsd?: number;
  size?: number;
  stroke?: number;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState<ProviderKeyInfo | null>(null);

  // Lazily fetch the active provider's remaining balance (TTL-cached, so the
  // ring re-mounting keeps one probe per minute). null when the provider
  // exposes no credits or offline → the Balance row is hidden.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const active = getActiveProvider();
      if (!active?.baseUrl) return;
      const cached = balanceCache;
      if (cached && cached.baseUrl === active.baseUrl && Date.now() - cached.fetchedAt < BALANCE_TTL_MS) {
        if (!cancelled) setBalance(cached.data);
        return;
      }
      const apiKey = await getProviderApiKey(active.id).catch(() => null);
      if (cancelled) return;
      const data = apiKey ? await getKeyInfo(active.baseUrl, apiKey) : null;
      balanceCache = { baseUrl: active.baseUrl, data, fetchedAt: Date.now() };
      if (!cancelled) setBalance(data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const { pct, colour, r, circ, dash } = useMemo(() => {
    const p = contextLimit > 0 ? Math.min(promptTokens / contextLimit, 1) : 0;
    const radius = (size - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    return {
      pct: p,
      r: radius,
      circ: circumference,
      dash: p * circumference,
      colour: p > 0.85 ? t.danger : p > 0.65 ? t.warning : t.accent,
    };
  }, [promptTokens, contextLimit, size, stroke, t]);

  const pctLabel = `${estimated ? "~" : ""}${Math.round(pct * 100)}%`;
  const half = size / 2;

  const categories = useMemo(() => {
    const b = breakdown;
    return [
      { label: "System prompt", count: b?.systemPrompt ?? 0, color: t.textSecondary },
      { label: "Tool definitions", count: b?.tools ?? 0, color: t.accent },
      { label: "MCP & services", count: b?.mcp ?? 0, color: t.info },
      { label: "Skills", count: b?.skills ?? 0, color: t.warning },
      { label: "Conversation", count: b?.conversation ?? 0, color: t.success },
      { label: "Tool outputs", count: b?.toolOutputs ?? 0, color: t.danger },
    ].filter((c) => c.count > 0);
  }, [breakdown, t]);

  const thinkingTokens = reasoningTokens ?? 0;
  const answerTokens = Math.max(0, (completionTokens ?? 0) - thinkingTokens);
  const hasOutput = typeof completionTokens === "number" && completionTokens > 0;

  const a11yLabel = `Context ${pctLabel} used${estimated ? " (estimated)" : ""}. Tap for details.`;
  const summaryTitle = `${pctLabel} full · ${formatTokenCount(promptTokens)} / ${formatTokenCount(contextLimit)} tokens${estimated ? " (est.)" : ""}`;

  const ring = (
    <Svg width={size} height={size}>
      {/* -90° rotation so the arc starts at 12 o'clock, like desktop. */}
      <Circle cx={half} cy={half} r={r} fill="none" stroke={t.border} strokeWidth={stroke} />
      <Circle
        cx={half}
        cy={half}
        r={r}
        fill="none"
        stroke={colour}
        strokeWidth={stroke}
        strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${half} ${half})`}
      />
    </Svg>
  );

  // Non-iOS: SVG ring that opens an Alert with the same breakdown.
  const showDetailAlert = () => {
    const lines = [
      summaryTitle,
      "",
      ...(categories.length
        ? categories.map((c) => `• ${c.label}: ${formatTokenCount(c.count)}`)
        : ["A detailed breakdown appears after the next message."]),
    ];
    if (hasOutput) {
      lines.push("", "Output", `• Answer: ${formatTokenCount(answerTokens)}`);
      if (thinkingTokens > 0) lines.push(`• Thinking: ${formatTokenCount(thinkingTokens)}`);
      lines.push(`• Total: ${formatTokenCount(completionTokens as number)}`);
    }
    if (typeof costUsd === "number" && costUsd > 0) {
      lines.push("", `Cost: ${formatUsd(costUsd)}`);
    }
    if (balance && (balance.remaining != null || balance.usage != null || balance.isFreeTier === true)) {
      lines.push("", `Balance: ${formatBalance(balance)}`);
    }
    Alert.alert("Context usage", lines.join("\n"), [{ text: "OK" }]);
  };

  if (Platform.OS !== "ios") {
    return (
      <Pressable
        onPress={showDetailAlert}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        style={styles.trigger}
      >
        {ring}
      </Pressable>
    );
  }

  // iOS: native Button trigger (swallows the tap) + native Popover whose content
  // is arbitrary SwiftUI, letting us right-align the counts in a real column.
  const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });

  // Plain render helper (NOT a component) so it isn't re-created each render —
  // keeps a stable element identity and satisfies react-hooks/static-components.
  // `valueColor` tints the count to match its category; omit for muted grey.
  const row = (name: string, value: string, valueColor?: string) => (
    <HStack key={name} alignment="center" spacing={12}>
      <Text modifiers={[font({ textStyle: "subheadline" })]}>{name}</Text>
      <Spacer />
      <Text
        modifiers={[
          font({ textStyle: "subheadline", weight: "medium" }),
          monospacedDigit(),
          valueColor ? foregroundStyle(valueColor) : secondary,
        ]}
      >
        {value}
      </Text>
    </HStack>
  );

  // Native multi-segment bar: an HStack of coloured rectangles, each sized in
  // points proportional to its share of the context window, clipped to a
  // capsule. Rebuilds the desktop segmented bar in SwiftUI (no menu-row limits).
  const limit = Math.max(contextLimit, 1);
  let segWidths = categories.map((c) => Math.max(2, (c.count / limit) * BAR_INNER_WIDTH));
  let usedWidth = segWidths.reduce((a, b) => a + b, 0);
  // Each segment is floored at 2pt for visibility, so with many categories the
  // sum can exceed the bar — proportionally scale every segment down so they
  // all fit inside the capsule without clipping.
  if (usedWidth > BAR_INNER_WIDTH) {
    const scale = BAR_INNER_WIDTH / usedWidth;
    segWidths = segWidths.map((w) => w * scale);
    usedWidth = BAR_INNER_WIDTH;
  }
  const trackWidth = Math.max(0, BAR_INNER_WIDTH - usedWidth);
  const bar = (
    <HStack spacing={0} modifiers={[frame({ width: BAR_INNER_WIDTH, height: BAR_HEIGHT }), clipShape("capsule")]}>
      {categories.map((c, i) => (
        <Rectangle key={c.label} modifiers={[foregroundStyle(c.color), frame({ width: segWidths[i] })]} />
      ))}
      {/* Unused-context track fills the remainder. */}
      {trackWidth > 0 ? <Rectangle modifiers={[foregroundStyle(t.surface3), frame({ width: trackWidth })]} /> : null}
    </HStack>
  );

  return (
    <Host matchContents style={styles.host}>
      <Popover isPresented={open} onIsPresentedChange={setOpen} arrowEdge="top">
        <Popover.Trigger>
          <Button
            modifiers={[accessibilityLabel(a11yLabel)]}
            onPress={() => {
              haptics.selection();
              setOpen(true);
            }}
          >
            <RNHostView matchContents>{ring}</RNHostView>
          </Button>
        </Popover.Trigger>

        <Popover.Content>
          <VStack alignment="leading" spacing={10} modifiers={[padding({ all: 16 }), frame({ width: POPOVER_WIDTH })]}>
            <Text modifiers={[font({ textStyle: "footnote" }), secondary]}>{summaryTitle}</Text>

            {categories.length > 0 ? (
              <>
                {bar}
                <VStack alignment="leading" spacing={8}>
                  {categories.map((c) => row(c.label, formatTokenCount(c.count), c.color))}
                </VStack>
              </>
            ) : (
              <Text modifiers={[font({ textStyle: "footnote" }), secondary]}>
                A detailed breakdown appears after the next message.
              </Text>
            )}

            {hasOutput ? (
              <>
                <Divider />
                <Text modifiers={[font({ textStyle: "caption", weight: "semibold" })]}>Output</Text>
                <VStack alignment="leading" spacing={8}>
                  {row("Answer", formatTokenCount(answerTokens))}
                  {thinkingTokens > 0 ? row("Thinking", formatTokenCount(thinkingTokens)) : null}
                  {row("Total", formatTokenCount(completionTokens as number))}
                </VStack>
              </>
            ) : null}

            {typeof costUsd === "number" && costUsd > 0 ? (
              <>
                <Divider />
                {row("Cost", formatUsd(costUsd))}
              </>
            ) : null}

            {balance && (balance.remaining != null || balance.usage != null || balance.isFreeTier === true) ? (
              <>
                <Divider />
                {row("Balance", formatBalance(balance))}
              </>
            ) : null}

            {estimated ? (
              <Text modifiers={[font({ textStyle: "caption2" }), secondary]}>Estimated for this provider.</Text>
            ) : null}
          </VStack>
        </Popover.Content>
      </Popover>
    </Host>
  );
}

/** Compact token count: 1234 → "1.2K". */
function formatTokenCount(num: number): string {
  if (num >= 1000) return `${(num / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return num.toString();
}

/** USD cost: 0.00219 → "$0.0022"; tiny costs (e.g. $0.000001) keep a significant digit instead of collapsing to "$0". */
function formatUsd(cost: number): string {
  if (cost === 0) return "$0";
  if (cost >= 0.00001) return `$${cost.toFixed(5).replace(/\.?0+$/, "")}`;
  return `$${parseFloat(cost.toPrecision(2)).toString()}`;
}

/** "5.42 of 45.5" / "5.42" / "Free tier" / "Used 40.08" for the Balance row. */
function formatBalance(b: ProviderKeyInfo): string {
  const sym = b.currency === "CNY" ? "¥" : "$";
  const fmt = (n: number) => {
    const abs = Math.abs(n);
    const digits = abs > 0 && abs < 1 ? 4 : 2;
    return `${sym}${abs.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: digits })}`;
  };
  if (b.remaining != null) {
    return b.limit != null ? `${fmt(b.remaining)} of ${fmt(b.limit)}` : fmt(b.remaining);
  }
  if (b.isFreeTier === true) return "Free tier";
  if (b.usage != null && b.usage > 0) return `Used ${fmt(b.usage)}`;
  return "Free tier";
}

/** Convenience: build props from a ChatUsage object. */
export type ContextRingUsage = ChatUsage;

const styles = StyleSheet.create({
  trigger: { paddingHorizontal: 4, alignItems: "center", justifyContent: "center" },
  host: { paddingHorizontal: 4 },
});
