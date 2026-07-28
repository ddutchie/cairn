import { useMemo, useState } from "react";
import { Alert, Platform, Pressable, StyleSheet } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { Host, Popover, RNHostView, Button, VStack, HStack, Spacer, Text, Divider } from "@expo/ui/swift-ui";
import { font, foregroundStyle, frame, padding, monospacedDigit } from "@expo/ui/swift-ui/modifiers";
import { useTheme } from "@/theme";
import { haptics } from "@/haptics";
import type { ChatUsage } from "@/chat/providers/types";
import type { TokenBreakdown } from "@/chat/token-breakdown";

const POPOVER_WIDTH = 260;

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
  const [open, setOpen] = useState(false);

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
  const countModifiers = [font({ textStyle: "subheadline" }), monospacedDigit(), secondary];

  // Plain render helper (NOT a component) so it isn't re-created each render —
  // keeps a stable element identity and satisfies react-hooks/static-components.
  const row = (name: string, value: string) => (
    <HStack key={name} alignment="center" spacing={12}>
      <Text modifiers={[font({ textStyle: "subheadline" })]}>{name}</Text>
      <Spacer />
      <Text modifiers={countModifiers}>{value}</Text>
    </HStack>
  );

  return (
    <Host matchContents style={styles.host}>
      <Popover isPresented={open} onIsPresentedChange={setOpen} arrowEdge="top">
        <Popover.Trigger>
          <Button
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
              <VStack alignment="leading" spacing={8}>
                {categories.map((c) => row(c.label, formatTokenCount(c.count)))}
              </VStack>
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

/** Convenience: build props from a ChatUsage object. */
export type ContextRingUsage = ChatUsage;

const styles = StyleSheet.create({
  trigger: { paddingHorizontal: 4, alignItems: "center", justifyContent: "center" },
  host: { paddingHorizontal: 4 },
});
