import { useCallback, useMemo } from "react";
import { Alert, Platform, Pressable, StyleSheet, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { Host, Menu, Button, RNHostView } from "@expo/ui/swift-ui";
import { haptics } from "@/haptics";
import { useTheme } from "@/theme";

/**
 * Context-window usage ring — the mobile analogue of the desktop ContextRing
 * (src/components/agent/ContextRing.tsx). A compact SVG donut whose arc fills
 * with the fraction of the model's context window used by the conversation.
 *
 * Ring-only (no inline label); tapping it opens a native menu with the exact
 * percentage + token counts (a glass `@expo/ui` Menu on iOS, an Alert fallback
 * elsewhere). Threshold colours match desktop: accent <=65%, warning 65–85%,
 * danger >85%.
 */
export function ContextRing({
  promptTokens,
  contextLimit,
  estimated = false,
  size = 22,
  stroke = 3.5,
}: {
  promptTokens: number;
  contextLimit: number;
  /** promptTokens is a client-side estimate (shown as "~" / "about"). */
  estimated?: boolean;
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
  const tokensLabel = `${estimated ? "~" : ""}${promptTokens.toLocaleString()} / ${contextLimit.toLocaleString()} tokens`;
  const half = size / 2;

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

  // iOS: a native (glass) Menu anchored to the ring. The rows are informational
  // — the model's context usage — so they're shown as no-op buttons.
  if (Platform.OS === "ios") {
    return (
      <Host matchContents>
        <Menu
          label={
            <RNHostView matchContents>
              <Pressable
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={a11yLabel}
                onPress={() => haptics.selection()}
                style={styles.wrap}
              >
                {ring}
              </Pressable>
            </RNHostView>
          }
        >
          <Button label={`Context ${pctLabel} used`} systemImage="gauge.with.dots.needle.67percent" onPress={noop} />
          <Button label={tokensLabel} systemImage="number" onPress={noop} />
          {estimated ? (
            <Button label="Estimated for this provider" systemImage="questionmark.circle" onPress={noop} />
          ) : null}
        </Menu>
      </Host>
    );
  }

  // Non-iOS fallback: keep the Alert popup.
  return <RingButton ring={ring} a11yLabel={a11yLabel} pctLabel={pctLabel} promptTokens={promptTokens} contextLimit={contextLimit} estimated={estimated} />;
}

function noop() {}

function RingButton({
  ring,
  a11yLabel,
  pctLabel,
  promptTokens,
  contextLimit,
  estimated,
}: {
  ring: React.ReactNode;
  a11yLabel: string;
  pctLabel: string;
  promptTokens: number;
  contextLimit: number;
  estimated: boolean;
}) {
  const showDetail = useCallback(() => {
    haptics.selection();
    const approx = estimated ? "about " : "";
    Alert.alert(
      "Context usage",
      `${pctLabel} of the model's context window is in use.\n\n${approx}${promptTokens.toLocaleString()} of ${contextLimit.toLocaleString()} tokens.` +
        (estimated ? "\n\nToken count is estimated for this provider." : ""),
      [{ text: "OK" }],
    );
  }, [pctLabel, promptTokens, contextLimit, estimated]);

  return (
    <Pressable onPress={showDetail} hitSlop={10} accessibilityRole="button" accessibilityLabel={a11yLabel} style={styles.wrap}>
      <View>{ring}</View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center", paddingHorizontal: 4 },
});
