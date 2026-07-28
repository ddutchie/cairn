import { useMemo } from "react";
import { Alert, StyleSheet } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { Button, Section } from "@expo/ui/swift-ui";
import { GlassMenu } from "@/components/GlassMenu";
import { useTheme } from "@/theme";
import type { ChatUsage } from "@/chat/providers/types";
import type { TokenBreakdown } from "@/chat/token-breakdown";

/**
 * Context-window usage ring — the mobile analogue of the desktop ContextRing
 * (src/components/agent/ContextRing.tsx). A compact SVG donut whose arc fills
 * with the fraction of the model's context window used by the conversation.
 *
 * Tapping it opens a NATIVE glass menu (GlassMenu → @expo/ui Menu) showing the
 * full breakdown as native single-line rows — the category name and its token
 * count — grouped under the summary section, plus an Output section (answer /
 * thinking / total) once a turn completes. (SwiftUI menu rows are single-line
 * only, so the count shares the row with the name.)
 *
 * Why native (not a custom Modal/popover): a native Menu host consumes the tap
 * at the SwiftUI layer, so a tap on the ring in the header never leaks to iOS's
 * status-bar "scroll to top" gesture (which a custom RN view in headerLeft does
 * trigger). Threshold colours match desktop: accent <=65%, warning 65–85%,
 * danger >85%. Non-iOS falls back to an Alert with the same figures.
 */
export function ContextRing({
  promptTokens,
  contextLimit,
  estimated = false,
  breakdown,
  completionTokens,
  reasoningTokens,
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
  size?: number;
  stroke?: number;
}) {
  const t = useTheme();

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

  // Per-category rows, in the same order/colour intent as desktop.
  const categories = useMemo(() => {
    const b = breakdown;
    return [
      { label: "System prompt", count: b?.systemPrompt ?? 0 },
      { label: "Tool definitions", count: b?.tools ?? 0 },
      { label: "MCP & services", count: b?.mcp ?? 0 },
      { label: "Skills", count: b?.skills ?? 0 },
      { label: "Conversation", count: b?.conversation ?? 0 },
      { label: "Tool outputs", count: b?.toolOutputs ?? 0 },
    ].filter((c) => c.count > 0);
  }, [breakdown]);

  const thinkingTokens = reasoningTokens ?? 0;
  const answerTokens = Math.max(0, (completionTokens ?? 0) - thinkingTokens);
  const hasOutput = typeof completionTokens === "number" && completionTokens > 0;

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

  const a11yLabel = `Context ${pctLabel} used${estimated ? " (estimated)" : ""}. Tap for details.`;
  const summaryTitle = `${pctLabel} full · ${formatTokenCount(promptTokens)} / ${formatTokenCount(contextLimit)} tokens${estimated ? " (est.)" : ""}`;

  // Non-iOS fallback: an Alert listing the same breakdown.
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
    Alert.alert("Context usage", lines.join("\n"), [{ text: "OK" }]);
  };

  return (
    <GlassMenu
      trigger={ring}
      accessibilityLabel={a11yLabel}
      onFallbackPress={showDetailAlert}
      triggerStyle={styles.trigger}
    >
      {/* Summary as the section title → small, muted caption; per-category rows
          below it (single-line: "Name   Count", since menu rows can't wrap). */}
      <Section title={summaryTitle}>
        {categories.length > 0 ? (
          categories.map((c) => (
            <Button key={c.label} label={`${c.label}   ${formatTokenCount(c.count)}`} onPress={noop} />
          ))
        ) : (
          <Button label="Breakdown appears after the next message" systemImage="clock" onPress={noop} />
        )}
      </Section>

      {hasOutput ? (
        <Section title="Output">
          <Button label={`Answer   ${formatTokenCount(answerTokens)}`} onPress={noop} />
          {thinkingTokens > 0 ? <Button label={`Thinking   ${formatTokenCount(thinkingTokens)}`} onPress={noop} /> : null}
          <Button label={`Total   ${formatTokenCount(completionTokens as number)}`} onPress={noop} />
        </Section>
      ) : null}

      {estimated ? (
        <Section>
          <Button label="Estimated for this provider" systemImage="questionmark.circle" onPress={noop} />
        </Section>
      ) : null}
    </GlassMenu>
  );
}

function noop() {}

/** Compact token count: 1234 → "1.2K". */
function formatTokenCount(num: number): string {
  if (num >= 1000) return `${(num / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return num.toString();
}

/** Convenience: build props from a ChatUsage object. */
export type ContextRingUsage = ChatUsage;

const styles = StyleSheet.create({
  trigger: { paddingHorizontal: 4 },
});
